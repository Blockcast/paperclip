import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  documentRevisions,
  documents,
  environments,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issueInboxArchives,
  issueApprovals,
  issueDocuments,
  issuePlanDecompositions,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  getBlockerResolvedWakeMetric,
  resetBlockerResolvedWakeMetrics,
} from "../services/blocker-resolved-wake-metrics.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  clampIssueListLimit,
  deriveIssueCommentRunLogAttribution,
  extractExecutiveHoldMarker,
  findActiveExecutiveHold,
  ISSUE_LIST_MAX_LIMIT,
  issueService,
  parseExecutiveHoldMarkerTimestamp,
} from "../services/issues.ts";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import {
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
} from "../services/execution-workspace-policy.ts";
import { buildAgentMentionHref, buildProjectMentionHref, MAX_ISSUE_REQUEST_DEPTH, type IssueWorkMode } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("issue list limit helpers", () => {
  it("clamps untrusted issue-list limits to the server maximum", () => {
    expect(clampIssueListLimit(0)).toBe(1);
    expect(clampIssueListLimit(25.9)).toBe(25);
    expect(clampIssueListLimit(ISSUE_LIST_MAX_LIMIT + 10)).toBe(ISSUE_LIST_MAX_LIMIT);
  });
});

describe("executive hold marker parsing", () => {
  it("parses strict ISO-8601 with Z", () => {
    const date = parseExecutiveHoldMarkerTimestamp("2026-05-07T03:00:00Z");
    expect(date?.toISOString()).toBe("2026-05-07T03:00:00.000Z");
  });

  it("parses loose `YYYY-MM-DD HH:MM UTC` form", () => {
    const date = parseExecutiveHoldMarkerTimestamp("2026-05-07 03:00 UTC");
    expect(date?.toISOString()).toBe("2026-05-07T03:00:00.000Z");
  });

  it("returns null for unparseable strings", () => {
    expect(parseExecutiveHoldMarkerTimestamp("tomorrow")).toBeNull();
    expect(parseExecutiveHoldMarkerTimestamp("")).toBeNull();
  });

  it("extracts strict ISO timestamp from a comment body", () => {
    const date = extractExecutiveHoldMarker(
      "Pausing this — do not retry before 2026-05-07T03:00:00Z, see thread.",
    );
    expect(date?.toISOString()).toBe("2026-05-07T03:00:00.000Z");
  });

  it("extracts loose timestamp from a comment body", () => {
    const date = extractExecutiveHoldMarker(
      "Hold this until tomorrow. Do not retry before 2026-05-07 03:00 UTC.",
    );
    expect(date?.toISOString()).toBe("2026-05-07T03:00:00.000Z");
  });

  it("returns null when body has no marker", () => {
    expect(extractExecutiveHoldMarker("Just a regular comment.")).toBeNull();
    expect(extractExecutiveHoldMarker(null)).toBeNull();
  });

  it("treats newest matching executive comment as authoritative", () => {
    const now = new Date("2026-05-06T00:00:00Z");
    const hold = findActiveExecutiveHold(
      [
        {
          id: "old",
          body: "do not retry before 2026-05-04T00:00:00Z",
          createdAt: new Date("2026-05-03T00:00:00Z"),
          authorRole: "ceo",
        },
        {
          id: "new",
          body: "do not retry before 2026-05-07 03:00 UTC",
          createdAt: new Date("2026-05-05T23:00:00Z"),
          authorRole: "cto",
        },
      ],
      now,
    );
    expect(hold).toMatchObject({ commentId: "new" });
    expect(hold?.until.toISOString()).toBe("2026-05-07T03:00:00.000Z");
  });

  it("ignores hold markers from non-executive authors", () => {
    const now = new Date("2026-05-06T00:00:00Z");
    const hold = findActiveExecutiveHold(
      [
        {
          id: "engineer-comment",
          body: "do not retry before 2026-05-07T03:00:00Z",
          createdAt: new Date("2026-05-05T23:00:00Z"),
          authorRole: "engineer",
        },
      ],
      now,
    );
    expect(hold).toBeNull();
  });

  it("releases the hold when the newest match has an expired timestamp", () => {
    const now = new Date("2026-05-08T00:00:00Z");
    const hold = findActiveExecutiveHold(
      [
        {
          id: "expired",
          body: "do not retry before 2026-05-07T03:00:00Z",
          createdAt: new Date("2026-05-05T23:00:00Z"),
          authorRole: "ceo",
        },
      ],
      now,
    );
    expect(hold).toBeNull();
  });
});

describe("deriveIssueCommentRunLogAttribution", () => {
  it("recovers agent attribution from run logs that printed the posted comment id", () => {
    const commentId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();

    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "user-1",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId,
          agentId,
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: `comment id: ${commentId}\n`,
        },
      ],
    );

    expect(derived.get(commentId)).toEqual({
      derivedAuthorAgentId: agentId,
      derivedCreatedByRunId: runId,
      derivedAuthorSource: "run_log_comment_post",
    });
  });

  it("resolves directly from the comment's own run id without reading logs", () => {
    const commentId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();

    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "local-board",
          createdByRunId: runId,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId,
          agentId,
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: "",
        },
      ],
    );

    expect(derived.get(commentId)).toEqual({
      derivedAuthorAgentId: agentId,
      derivedCreatedByRunId: runId,
      derivedAuthorSource: "run_id",
    });
  });

  it("does NOT attribute on run-window overlap alone — timing is not a lossless signal (option A)", () => {
    // A human board comment can land inside an agent's run window; since both are
    // stored as `local-board`, a timing-only guess would mis-attribute it. So a
    // single overlapping run with no run-id and no log marker stays unresolved.
    const commentId = randomUUID();
    const runId = randomUUID();
    const agentId = randomUUID();

    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "local-board",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId,
          agentId,
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: "posted results without echoing the comment id",
        },
      ],
    );

    expect(derived.has(commentId)).toBe(false);
  });

  it("does not guess when multiple agent runs overlap and no log proves the author", () => {
    const commentId = randomUUID();
    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "local-board",
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId: randomUUID(),
          agentId: randomUUID(),
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: "no comment id here",
        },
        {
          runId: randomUUID(),
          agentId: randomUUID(),
          createdAt: new Date("2026-05-11T18:54:00.000Z"),
          startedAt: new Date("2026-05-11T18:54:00.000Z"),
          finishedAt: new Date("2026-05-11T18:56:00.000Z"),
          logContent: "also nothing",
        },
      ],
    );

    expect(derived.has(commentId)).toBe(false);
  });

  it("does NOT attribute on same-agent run-window overlap alone (option A)", () => {
    // Even when every overlapping run is the same agent, timing alone cannot
    // prove the comment was the agent's vs a human board comment during the run.
    const commentId = randomUUID();
    const agentId = randomUUID();

    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: null,
          authorUserId: "local-board",
          createdByRunId: null,
          createdAt: new Date("2026-06-29T17:41:59.916Z"),
        },
      ],
      [
        {
          runId: randomUUID(),
          agentId,
          createdAt: new Date("2026-06-29T17:41:26.116Z"),
          startedAt: new Date("2026-06-29T17:41:26.116Z"),
          finishedAt: new Date("2026-06-29T17:46:33.794Z"),
          logContent: "no comment id here",
        },
        {
          runId: randomUUID(),
          agentId,
          createdAt: new Date("2026-06-29T17:40:09.531Z"),
          startedAt: new Date("2026-06-29T17:40:09.531Z"),
          finishedAt: new Date("2026-06-29T17:46:33.794Z"),
          logContent: "also nothing",
        },
      ],
    );

    expect(derived.has(commentId)).toBe(false);
  });

  it("never reattributes a comment that already has a stored agent author", () => {
    const commentId = randomUUID();
    const derived = deriveIssueCommentRunLogAttribution(
      [
        {
          id: commentId,
          authorAgentId: randomUUID(),
          authorUserId: null,
          createdByRunId: null,
          createdAt: new Date("2026-05-11T18:55:40.090Z"),
        },
      ],
      [
        {
          runId: randomUUID(),
          agentId: randomUUID(),
          createdAt: new Date("2026-05-11T18:51:56.246Z"),
          startedAt: new Date("2026-05-11T18:51:56.257Z"),
          finishedAt: new Date("2026-05-11T18:55:45.600Z"),
          logContent: "",
        },
      ],
    );

    expect(derived.has(commentId)).toBe(false);
  });
});

describeEmbeddedPostgres("issueService.addComment idempotency", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-idempotency-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("suppresses a same-window unchanged fingerprint even when the renderer changes", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent health and stalled-issue alerts",
      status: "done",
      priority: "medium",
    });

    const idempotencyKey = "agent-health:2026-07-30T12:00:00.000Z:7bedaee78643280797da9151a9d5a08572aaa17d7e345c884069924f040fdc0c";
    const first = await svc.addComment(issueId, "13:38 renderer payload\n", {}, { idempotencyKey });
    const second = await svc.addComment(issueId, "13:39 renderer payload in a new format", {}, { idempotencyKey });

    expect(second).toMatchObject({ id: first.id, body: first.body, deduplicated: true });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });

  it("scopes comment idempotency keys to the authenticated author", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent health and stalled-issue alerts",
      status: "done",
      priority: "medium",
    });

    const key = "agent-health:2026-07-30T12:00:00.000Z:shared-fingerprint";
    const first = await svc.addComment(issueId, "Alice alert", { userId: "alice" }, { idempotencyKey: key });
    const second = await svc.addComment(issueId, "Bob alert", { userId: "bob" }, { idempotencyKey: key });
    const replay = await svc.addComment(issueId, "Alice alert replay", { userId: "alice" }, { idempotencyKey: key });

    expect(second.id).not.toBe(first.id);
    expect(replay).toMatchObject({ id: first.id, body: first.body, deduplicated: true });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
  });

  it("keeps different fingerprints in the same window distinct", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent health and stalled-issue alerts",
      status: "done",
      priority: "medium",
    });

    await svc.addComment(issueId, "First alert set", {}, {
      idempotencyKey: "agent-health:2026-07-30T12:00:00.000Z:fingerprint-a",
    });
    await svc.addComment(issueId, "Meaningfully changed alert set", {}, {
      idempotencyKey: "agent-health:2026-07-30T12:00:00.000Z:fingerprint-b",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
  });

  it("serializes concurrent emits for the same window and fingerprint", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "BLO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent health and stalled-issue alerts",
      status: "done",
      priority: "medium",
    });

    const key = "agent-health:2026-07-30T12:00:00.000Z:7bedaee78643280797da9151a9d5a08572aaa17d7e345c884069924f040fdc0c";
    const [first, second] = await Promise.all([
      issueService(db).addComment(issueId, "13:38 payload", {}, { idempotencyKey: key }),
      issueService(db).addComment(issueId, "13:39 payload", {}, { idempotencyKey: key }),
    ]);

    expect(first.id).toBe(second.id);
    expect(["deduplicated" in first, "deduplicated" in second]).toContain(true);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
  });
});

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.list participantAgentId", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issueDocuments);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(documents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAssignableAgentCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("returns a typed conflict for a duplicate active alert escalation cover", async () => {
    const companyId = await seedAssignableAgentCompany();
    const originFingerprint = "cover:PodPendingCritical:123";
    await svc.create(companyId, {
      title: "First escalation cover",
      status: "todo",
      priority: "critical",
      originKind: "plugin:paperclip-plugin-alertmanager:escalation",
      originId: randomUUID(),
      originFingerprint,
    });

    await expect(svc.create(companyId, {
      title: "Duplicate escalation cover",
      status: "todo",
      priority: "critical",
      originKind: "plugin:paperclip-plugin-alertmanager:escalation",
      originId: randomUUID(),
      originFingerprint,
    })).rejects.toMatchObject({
      status: 409,
      message: "Alert escalation cover conflict",
      details: { companyId, originFingerprint },
    });
  });

  function agentRow(companyId: string, input: {
    id: string;
    name: string;
    status?: string;
    reportsTo?: string | null;
  }) {
    return {
      id: input.id,
      companyId,
      name: input.name,
      role: "engineer",
      status: input.status ?? "active",
      reportsTo: input.reportsTo ?? null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    };
  }

  it("rejects direct terminated assignees with structured conflict details", async () => {
    const companyId = await seedAssignableAgentCompany();
    const terminatedAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, {
      id: terminatedAgentId,
      name: "TerminatedCoder",
      status: "terminated",
    }));

    await expect(svc.create(companyId, {
      title: "Do not assign this",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: terminatedAgentId,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId: terminatedAgentId,
      },
    });
  });

  it("rejects invalid ancestor-chain assignees and preserves the existing assignment", async () => {
    const companyId = await seedAssignableAgentCompany();
    const activeAgentId = randomUUID();
    const terminatedManagerId = randomUUID();
    const blockedAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: activeAgentId, name: "ActiveCoder" }),
      agentRow(companyId, {
        id: terminatedManagerId,
        name: "TerminatedManager",
        status: "terminated",
      }),
      agentRow(companyId, {
        id: blockedAgentId,
        name: "BlockedCoder",
        reportsTo: terminatedManagerId,
      }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Keep current assignment",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: activeAgentId,
    });

    await expect(svc.update(issue.id, {
      assigneeAgentId: blockedAgentId,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "ancestor_terminated",
        assigneeAgentId: blockedAgentId,
        invalidAncestorAgentId: terminatedManagerId,
      },
    });

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted?.assigneeAgentId).toBe(activeAgentId);
  });

  it("rejects checkout by a terminated agent before assigning the issue", async () => {
    const companyId = await seedAssignableAgentCompany();
    const terminatedAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, {
      id: terminatedAgentId,
      name: "TerminatedCheckoutCoder",
      status: "terminated",
    }));
    const issue = await svc.create(companyId, {
      title: "Checkout must stay unassigned",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
    });

    await expect(svc.checkout(issue.id, terminatedAgentId, ["todo"], randomUUID()))
      .rejects.toMatchObject({
        status: 409,
        details: {
          code: "agent_not_assignable",
          reason: "assignee_terminated",
          assigneeAgentId: terminatedAgentId,
        },
      });

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toMatchObject({
      assigneeAgentId: null,
      status: "todo",
    });
  });

  it("lets an active source-scoped recovery owner checkout the source issue", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    const recoveryOwnerAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: assigneeAgentId, name: "BlockedCoder" }),
      agentRow(companyId, { id: recoveryOwnerAgentId, name: "RecoveryOwner" }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Recover source issue",
      description: null,
      status: "blocked",
      priority: "high",
      assigneeAgentId,
    });
    await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issue.id,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `recovery:${issue.id}`,
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    const checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId: recoveryOwnerAgentId,
      status: "running",
      invocationSource: "manual",
    });
    const checkedOut = await svc.checkout(
      issue.id,
      recoveryOwnerAgentId,
      ["blocked"],
      checkoutRunId,
      { allowSourceScopedRecoveryOwner: true },
    );

    expect(checkedOut).toMatchObject({
      id: issue.id,
      assigneeAgentId: recoveryOwnerAgentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
      status: "in_progress",
    });
  });

  it("lets an escalated source-scoped recovery owner checkout the source issue", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    const recoveryOwnerAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: assigneeAgentId, name: "EscalatedBlockedCoder" }),
      agentRow(companyId, { id: recoveryOwnerAgentId, name: "EscalatedRecoveryOwner" }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Recover escalated source issue",
      description: null,
      status: "blocked",
      priority: "high",
      assigneeAgentId,
    });
    const recoveryAction = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issue.id,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `recovery:${issue.id}`,
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    await db
      .update(issueRecoveryActions)
      .set({ status: "escalated" })
      .where(eq(issueRecoveryActions.id, recoveryAction.id));

    const checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId: recoveryOwnerAgentId,
      status: "running",
      invocationSource: "manual",
    });
    const checkedOut = await svc.checkout(
      issue.id,
      recoveryOwnerAgentId,
      ["blocked"],
      checkoutRunId,
      { allowSourceScopedRecoveryOwner: true },
    );

    expect(checkedOut).toMatchObject({
      id: issue.id,
      assigneeAgentId: recoveryOwnerAgentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
      status: "in_progress",
    });
  });

  it("rejects source-scoped recovery checkout when the recovery action is no longer active", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    const recoveryOwnerAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: assigneeAgentId, name: "ResolvedBlockedCoder" }),
      agentRow(companyId, { id: recoveryOwnerAgentId, name: "ResolvedRecoveryOwner" }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Reject resolved recovery action",
      description: null,
      status: "blocked",
      priority: "high",
      assigneeAgentId,
    });
    const recoveryAction = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId: issue.id,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: recoveryOwnerAgentId,
      cause: "stranded_assigned_issue",
      fingerprint: `recovery:${issue.id}`,
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    await db
      .update(issueRecoveryActions)
      .set({ status: "resolved" })
      .where(eq(issueRecoveryActions.id, recoveryAction.id));

    const checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId: recoveryOwnerAgentId,
      status: "running",
      invocationSource: "manual",
    });

    await expect(
      svc.checkout(issue.id, recoveryOwnerAgentId, ["blocked"], checkoutRunId, {
        allowSourceScopedRecoveryOwner: true,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout failed — authorization or status mismatch",
    });
  });

  it("does not let unrelated non-assignees use the recovery-owner checkout path", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: assigneeAgentId, name: "BlockedCoder" }),
      agentRow(companyId, { id: otherAgentId, name: "OtherCoder" }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Keep ownership scoped",
      description: null,
      status: "blocked",
      priority: "high",
      assigneeAgentId,
    });

    const checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
      invocationSource: "manual",
    });

    await expect(
      svc.checkout(issue.id, otherAgentId, ["blocked"], checkoutRunId, { allowSourceScopedRecoveryOwner: true }),
    ).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout failed — authorization or status mismatch",
    });
  });

  it("rejects non-assignee checkout by default without source-scoped recovery authority", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values([
      agentRow(companyId, { id: assigneeAgentId, name: "DefaultBlockedCoder" }),
      agentRow(companyId, { id: otherAgentId, name: "DefaultOtherCoder" }),
    ]);
    const issue = await svc.create(companyId, {
      title: "Keep default checkout ownership strict",
      description: null,
      status: "blocked",
      priority: "high",
      assigneeAgentId,
    });

    const checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: checkoutRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
      invocationSource: "manual",
    });

    await expect(svc.checkout(issue.id, otherAgentId, ["blocked"], checkoutRunId)).rejects.toMatchObject({
      status: 409,
      message: "Issue checkout conflict",
    });
  });

  it("rejects moving an existing terminated assignment into progress without clearing it", async () => {
    const companyId = await seedAssignableAgentCompany();
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values(agentRow(companyId, {
      id: assigneeAgentId,
      name: "SoonTerminatedCoder",
    }));
    const issue = await svc.create(companyId, {
      title: "Do not restart after termination",
      description: null,
      status: "todo",
      priority: "medium",
      assigneeAgentId,
    });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, assigneeAgentId));

    await expect(svc.update(issue.id, {
      status: "in_progress",
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "agent_not_assignable",
        reason: "assignee_terminated",
        assigneeAgentId,
      },
    });

    const persisted = await db
      .select({ assigneeAgentId: issues.assigneeAgentId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.id))
      .then((rows) => rows[0] ?? null);
    expect(persisted).toMatchObject({
      assigneeAgentId,
      status: "todo",
    });
  });

  it("resolves only structured same-company agent mentions", async () => {
    const companyId = await seedAssignableAgentCompany();
    const otherCompanyId = await seedAssignableAgentCompany();
    const localAgentId = randomUUID();
    const foreignAgentId = randomUUID();

    await db.insert(agents).values([
      agentRow(companyId, { id: localAgentId, name: "LocalAgent" }),
      agentRow(otherCompanyId, { id: foreignAgentId, name: "ForeignAgent" }),
    ]);

    const mentions = await svc.findMentionedAgents(
      companyId,
      [
        `hello [@LocalAgent](${buildAgentMentionHref(localAgentId)})`,
        `and [@ForeignAgent](${buildAgentMentionHref(foreignAgentId)})`,
      ].join(" "),
    );

    expect(mentions).toEqual([localAgentId]);
  });

  it("does not wake agents from raw @name text without a structured mention", async () => {
    const companyId = await seedAssignableAgentCompany();
    const localAgentId = randomUUID();

    await db.insert(agents).values([
      agentRow(companyId, { id: localAgentId, name: "LocalAgent" }),
    ]);

    await expect(svc.findMentionedAgents(companyId, "@LocalAgent please inspect this"))
      .resolves.toEqual([]);
  });

  it("returns issues an agent participated in across the supported signals", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const assignedIssueId = randomUUID();
    const createdIssueId = randomUUID();
    const commentedIssueId = randomUUID();
    const activityIssueId = randomUUID();
    const excludedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        createdByAgentId: otherAgentId,
      },
      {
        id: createdIssueId,
        companyId,
        title: "Created issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: commentedIssueId,
        companyId,
        title: "Commented issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: activityIssueId,
        companyId,
        title: "Activity issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
      },
      {
        id: excludedIssueId,
        companyId,
        title: "Excluded issue",
        status: "todo",
        priority: "medium",
        createdByAgentId: otherAgentId,
        assigneeAgentId: otherAgentId,
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentedIssueId,
      authorAgentId: agentId,
      body: "Investigating this issue.",
    });

    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue.updated",
      entityType: "issue",
      entityId: activityIssueId,
      agentId,
      details: { changed: true },
    });

    const result = await svc.list(companyId, { participantAgentId: agentId });
    const resultIds = new Set(result.map((issue) => issue.id));

    expect(resultIds).toEqual(new Set([
      assignedIssueId,
      createdIssueId,
      commentedIssueId,
      activityIssueId,
    ]));
    expect(resultIds.has(excludedIssueId)).toBe(false);
  });

  it("combines participation filtering with search", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const matchedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: matchedIssueId,
        companyId,
        title: "Invoice reconciliation",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Weekly planning",
        status: "todo",
        priority: "medium",
        createdByAgentId: agentId,
      },
    ]);

    const result = await svc.list(companyId, {
      participantAgentId: agentId,
      q: "invoice",
    });

    expect(result.map((issue) => issue.id)).toEqual([matchedIssueId]);
  });

  it("treats assigneeAgentId='null' as an explicit unassigned filter", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    const result = await svc.list(companyId, { assigneeAgentId: "null" });
    expect(result.map((issue) => issue.id)).toEqual([unassignedIssueId]);
  });

  it("keeps UUID assignee filtering behavior unchanged", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: otherAgentId,
      },
    ]);

    const result = await svc.list(companyId, { assigneeAgentId });
    expect(result.map((issue) => issue.id)).toEqual([assignedIssueId]);
  });

  it("rejects malformed assigneeAgentId filter values", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Any issue",
      status: "todo",
      priority: "medium",
    });

    await expect(
      svc.list(companyId, { assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });

  it("counts only unassigned issues for assigneeAgentId='null'", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const unassignedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: unassignedIssueId,
        companyId,
        title: "Unassigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
      },
    ]);

    await expect(svc.count(companyId, { assigneeAgentId: "null" })).resolves.toBe(1);
  });

  it("counts UUID-assigned issues with assigneeAgentId", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const assignedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: assignedIssueId,
        companyId,
        title: "Assigned issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await expect(svc.count(companyId, { assigneeAgentId })).resolves.toBe(1);
  });

  it("rejects malformed assigneeAgentId filter values in count", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.count(companyId, { assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });

  it("applies result limits to issue search", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const exactIdentifierId = randomUUID();
    const titleMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(issues).values([
      {
        id: exactIdentifierId,
        companyId,
        issueNumber: 42,
        identifier: "PAP-42",
        title: "Completely unrelated",
        status: "todo",
        priority: "medium",
      },
      {
        id: titleMatchId,
        companyId,
        title: "Search ranking issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Another item",
        description: "Contains the search keyword",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, {
      q: "search",
      limit: 2,
    });

    expect(result.map((issue) => issue.id)).toEqual([titleMatchId, descriptionMatchId]);
  });

  it("filters issues by whether they have a plan document", async () => {
    const companyId = randomUUID();
    const withPlanId = randomUUID();
    const withoutPlanId = randomUUID();
    const otherDocumentId = randomUUID();
    const planDocumentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: withPlanId,
        companyId,
        title: "Issue with plan",
        status: "todo",
        priority: "medium",
      },
      {
        id: withoutPlanId,
        companyId,
        title: "Issue without plan",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(documents).values([
      {
        id: planDocumentId,
        companyId,
        title: null,
        format: "markdown",
        latestBody: "# Plan",
      },
      {
        id: otherDocumentId,
        companyId,
        title: "Notes",
        format: "markdown",
        latestBody: "# Notes",
      },
    ]);

    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: withPlanId,
        documentId: planDocumentId,
        key: "plan",
      },
      {
        companyId,
        issueId: withoutPlanId,
        documentId: otherDocumentId,
        key: "notes",
      },
    ]);

    const withPlan = await svc.list(companyId, { hasPlanDocument: true });
    const withoutPlan = await svc.list(companyId, { hasPlanDocument: false });

    expect(withPlan.map((issue) => issue.id)).toEqual([withPlanId]);
    expect(withoutPlan.map((issue) => issue.id)).toEqual([withoutPlanId]);
  });

  it("can page issues by most recently updated before priority", async () => {
    const companyId = randomUUID();
    const oldCriticalIssueId = randomUUID();
    const recentMediumIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: oldCriticalIssueId,
        companyId,
        title: "Old critical issue",
        status: "todo",
        priority: "critical",
        updatedAt: new Date("2026-05-01T10:00:00.000Z"),
      },
      {
        id: recentMediumIssueId,
        companyId,
        title: "Recent medium issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-05-17T21:12:29.993Z"),
      },
    ]);

    const result = await svc.list(companyId, {
      limit: 1,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(result.map((issue) => issue.id)).toEqual([recentMediumIssueId]);
  });

  it("ranks comment matches ahead of description-only matches", async () => {
    const companyId = randomUUID();
    const commentMatchId = randomUUID();
    const descriptionMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: commentMatchId,
        companyId,
        title: "Comment match",
        status: "todo",
        priority: "medium",
      },
      {
        id: descriptionMatchId,
        companyId,
        title: "Description match",
        description: "Contains pull/3303 in the description",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentMatchId,
      body: "Reference: https://github.com/paperclipai/paperclip/pull/3303",
    });

    const result = await svc.list(companyId, {
      q: "pull/3303",
      limit: 2,
      includeRoutineExecutions: true,
    });

    expect(result.map((issue) => issue.id)).toEqual([commentMatchId, descriptionMatchId]);
  });

  it("filters issue lists to the full descendant tree for a root issue", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const siblingId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Child",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: siblingId,
        companyId,
        title: "Sibling",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId });

    expect(new Set(result.map((issue) => issue.id))).toEqual(new Set([childId, grandchildId]));
  });

  it("combines descendant filtering with search", async () => {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const outsideMatchId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: rootId,
        companyId,
        title: "Root",
        status: "todo",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId: rootId,
        title: "Relevant parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: grandchildId,
        companyId,
        parentId: childId,
        title: "Needle grandchild",
        status: "todo",
        priority: "medium",
      },
      {
        id: outsideMatchId,
        companyId,
        title: "Needle outside",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { descendantOf: rootId, q: "needle" });

    expect(result.map((issue) => issue.id)).toEqual([grandchildId]);
  });

  it("accepts issue identifiers with alphanumeric prefixes through getById", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PC1A2",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1064,
      identifier: "PC1A2-1064",
      title: "Feedback votes error",
      status: "todo",
      priority: "medium",
      createdByUserId: "user-1",
    });

    const issue = await svc.getById("pc1a2-1064");

    expect(issue).toEqual(
      expect.objectContaining({
        id: issueId,
        identifier: "PC1A2-1064",
      }),
    );
  });

  it("returns null instead of throwing for malformed non-uuid issue refs", async () => {
    await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
  });
  it("filters issues by execution workspace id", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const targetWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const linkedIssueId = randomUUID();
    const otherLinkedIssueId = randomUUID();
    const unlinkedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(executionWorkspaces).values([
      {
        id: targetWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Target workspace",
        status: "active",
        providerType: "local_fs",
      },
      {
        id: otherWorkspaceId,
        companyId,
        projectId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Other workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values([
      {
        id: linkedIssueId,
        companyId,
        projectId,
        title: "Linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: targetWorkspaceId,
      },
      {
        id: otherLinkedIssueId,
        companyId,
        projectId,
        title: "Other linked issue",
        status: "todo",
        priority: "medium",
        executionWorkspaceId: otherWorkspaceId,
      },
      {
        id: unlinkedIssueId,
        companyId,
        projectId,
        title: "Unlinked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const result = await svc.list(companyId, { executionWorkspaceId: targetWorkspaceId });

    expect(result.map((issue) => issue.id)).toEqual([linkedIssueId]);
  });

  it("filters issues by generic workspace id across execution and project workspace links", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const executionLinkedIssueId = randomUUID();
    const projectLinkedIssueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Feature workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: false,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Execution workspace",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values([
      {
        id: executionLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Execution linked issue",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: projectLinkedIssueId,
        companyId,
        projectId,
        projectWorkspaceId,
        title: "Project linked issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        projectId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    const executionResult = await svc.list(companyId, { workspaceId: executionWorkspaceId });
    const projectResult = await svc.list(companyId, { workspaceId: projectWorkspaceId });

    expect(executionResult.map((issue) => issue.id)).toEqual([executionLinkedIssueId]);
    expect(projectResult.map((issue) => issue.id).sort()).toEqual([executionLinkedIssueId, projectLinkedIssueId].sort());
  });

  it("hides plugin operation issues from default lists and inbox-style filters while preserving explicit retrieval", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const normalIssueId = randomUUID();
    const pluginVisibleIssueId = randomUUID();
    const operationIssueId = randomUUID();
    const typedOperationIssueId = randomUUID();
    const legacyContentMachineOperationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Plugin Runner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Plugin operations",
      status: "in_progress",
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        title: "Normal issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
      {
        id: pluginVisibleIssueId,
        companyId,
        title: "Plugin-visible issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:feature",
      },
      {
        id: operationIssueId,
        companyId,
        projectId,
        title: "Plugin operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:operation",
        originId: "mission-alpha:operation-1",
      },
      {
        id: typedOperationIssueId,
        companyId,
        projectId,
        title: "Typed plugin operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclip.missions:operation:evaluation",
        originId: "mission-alpha:operation-2",
      },
      {
        id: legacyContentMachineOperationIssueId,
        companyId,
        projectId,
        title: "Legacy Content Machine operation issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "plugin:paperclipai.content-machine:evaluation",
        originId: "content-machine-operation-1",
      },
    ]);

    const defaultIssueIds = (await svc.list(companyId)).map((issue) => issue.id);
    expect(defaultIssueIds).toContain(normalIssueId);
    expect(defaultIssueIds).toContain(pluginVisibleIssueId);
    expect(defaultIssueIds).not.toContain(operationIssueId);
    expect(defaultIssueIds).not.toContain(typedOperationIssueId);
    expect(defaultIssueIds).not.toContain(legacyContentMachineOperationIssueId);

    const inboxIssueIds = (await svc.list(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
      includeRoutineExecutions: true,
    })).map((issue) => issue.id);
    expect(inboxIssueIds).toContain(normalIssueId);
    expect(inboxIssueIds).not.toContain(operationIssueId);
    expect(inboxIssueIds).not.toContain(typedOperationIssueId);
    expect(inboxIssueIds).not.toContain(legacyContentMachineOperationIssueId);

    await expect(svc.list(companyId, { originKind: "plugin:paperclip.missions:operation" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);
    await expect(svc.list(companyId, { originId: "mission-alpha:operation-1" }))
      .resolves.toEqual([expect.objectContaining({ id: operationIssueId })]);
    await expect(svc.list(companyId, { originKindPrefix: "plugin:paperclip.missions:operation" }))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: operationIssueId }),
        expect.objectContaining({ id: typedOperationIssueId }),
      ]));

    const projectIssueIds = (await svc.list(companyId, { projectId })).map((issue) => issue.id);
    expect(projectIssueIds).toContain(operationIssueId);
    expect(projectIssueIds).toContain(typedOperationIssueId);
    expect(projectIssueIds).toContain(legacyContentMachineOperationIssueId);

    const advancedIssueIds = (await svc.list(companyId, { includePluginOperations: true })).map((issue) => issue.id);
    expect(advancedIssueIds).toContain(operationIssueId);
    expect(advancedIssueIds).toContain(typedOperationIssueId);
    expect(advancedIssueIds).toContain(legacyContentMachineOperationIssueId);
  });

  it("excludes routine execution issues from project-filtered backlog lists unless explicitly included", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const backlogIssueId = randomUUID();
    const routineExecutionIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "CDN+ Infrastructure",
      status: "in_progress",
    });
    await db.insert(issues).values([
      {
        id: backlogIssueId,
        companyId,
        projectId,
        title: "Backlog issue",
        status: "backlog",
        priority: "medium",
      },
      {
        id: routineExecutionIssueId,
        companyId,
        projectId,
        title: "Routine execution issue",
        status: "backlog",
        priority: "medium",
        originKind: "routine_execution",
        originId: "routine-1",
      },
    ]);

    const defaultProjectIds = (await svc.list(companyId, {
      status: "backlog",
      projectId,
      includeRoutineExecutions: false,
    })).map((issue) => issue.id);
    expect(defaultProjectIds).toEqual([backlogIssueId]);
    await expect(svc.count(companyId, {
      status: "backlog",
      projectId,
      includeRoutineExecutions: false,
    })).resolves.toBe(1);

    const includedProjectIds = (await svc.list(companyId, {
      status: "backlog",
      projectId,
      includeRoutineExecutions: true,
    })).map((issue) => issue.id);
    expect(new Set(includedProjectIds)).toEqual(new Set([backlogIssueId, routineExecutionIssueId]));

    await expect(svc.list(companyId, { originKind: "routine_execution" }))
      .resolves.toEqual([expect.objectContaining({ id: routineExecutionIssueId })]);
  });

  it("excludes plugin operation issues from unread inbox counts", async () => {
    const companyId = randomUUID();
    const userId = "board-user";
    const otherUserId = "other-user";
    const normalIssueId = randomUUID();
    const operationIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: normalIssueId,
        companyId,
        title: "Normal touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
      },
      {
        id: operationIssueId,
        companyId,
        title: "Plugin operation touched issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        originKind: "plugin:paperclip.missions:operation",
      },
    ]);
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: normalIssueId,
        authorUserId: otherUserId,
        body: "Unread normal update.",
      },
      {
        companyId,
        issueId: operationIssueId,
        authorUserId: otherUserId,
        body: "Unread operation update.",
      },
    ]);

    await expect(svc.countUnreadTouchedByUser(companyId, userId, "todo")).resolves.toBe(1);
    await expect(svc.countUnreadTouchedByUser(companyId, userId, ["todo", "in_progress"])).resolves.toBe(1);
  });

  it("accepts array-form status filters in list and count", async () => {
    const companyId = randomUUID();
    const todoIssueId = randomUUID();
    const inProgressIssueId = randomUUID();
    const doneIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: todoIssueId,
        companyId,
        title: "Todo issue",
        status: "todo",
        priority: "medium",
      },
      {
        id: inProgressIssueId,
        companyId,
        title: "In-progress issue",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: doneIssueId,
        companyId,
        title: "Done issue",
        status: "done",
        priority: "medium",
      },
    ]);

    const resultIds = (await svc.list(companyId, { status: ["todo", "in_progress"] }))
      .map((issue) => issue.id);

    expect(resultIds).toEqual(expect.arrayContaining([todoIssueId, inProgressIssueId]));
    expect(resultIds).not.toContain(doneIssueId);
    await expect(svc.count(companyId, { status: ["todo", "in_progress"] })).resolves.toBe(2);
  });

  it("hides archived inbox issues until new external activity arrives", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const visibleIssueId = randomUUID();
    const archivedIssueId = randomUUID();
    const resurfacedIssueId = randomUUID();

    await db.insert(issues).values([
      {
        id: visibleIssueId,
        companyId,
        title: "Visible issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: archivedIssueId,
        companyId,
        title: "Archived issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: resurfacedIssueId,
        companyId,
        title: "Resurfaced issue",
        status: "todo",
        priority: "medium",
        createdByUserId: userId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    await svc.archiveInbox(companyId, archivedIssueId, userId, new Date("2026-03-26T12:30:00.000Z"));
    await svc.archiveInbox(companyId, resurfacedIssueId, userId, new Date("2026-03-26T13:00:00.000Z"));

    await db.insert(issueComments).values({
      companyId,
      issueId: resurfacedIssueId,
      authorUserId: otherUserId,
      body: "This should bring the issue back into Mine.",
      createdAt: new Date("2026-03-26T13:30:00.000Z"),
      updatedAt: new Date("2026-03-26T13:30:00.000Z"),
    });

    const archivedFiltered = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(archivedFiltered.map((issue) => issue.id)).toEqual([
      resurfacedIssueId,
      visibleIssueId,
    ]);

    await svc.unarchiveInbox(companyId, archivedIssueId, userId);

    const afterUnarchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });

    expect(new Set(afterUnarchive.map((issue) => issue.id))).toEqual(new Set([
      visibleIssueId,
      archivedIssueId,
      resurfacedIssueId,
    ]));
  });

  it("resurfaces archived issue when status/updatedAt changes after archiving", async () => {
    const companyId = randomUUID();
    const userId = "user-1";
    const otherUserId = "user-2";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with old comment then status change",
      status: "todo",
      priority: "medium",
      createdByUserId: userId,
      createdAt: new Date("2026-03-26T10:00:00.000Z"),
      updatedAt: new Date("2026-03-26T10:00:00.000Z"),
    });

    // Old external comment before archiving
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorUserId: otherUserId,
      body: "Old comment before archive",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    // Archive after seeing the comment
    await svc.archiveInbox(
      companyId,
      issueId,
      userId,
      new Date("2026-03-26T12:00:00.000Z"),
    );

    // Verify it's archived
    const afterArchive = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterArchive.map((i) => i.id)).not.toContain(issueId);

    // Status/work update changes updatedAt (no new comment)
    await db
      .update(issues)
      .set({
        status: "in_progress",
        updatedAt: new Date("2026-03-26T13:00:00.000Z"),
      })
      .where(eq(issues.id, issueId));

    // Should resurface because updatedAt > archivedAt
    const afterUpdate = await svc.list(companyId, {
      touchedByUserId: userId,
      inboxArchivedByUserId: userId,
    });
    expect(afterUpdate.map((i) => i.id)).toContain(issueId);
  });

  it("sorts and exposes last activity from comments and non-local issue activity logs", async () => {
    const companyId = randomUUID();
    const olderIssueId = randomUUID();
    const commentIssueId = randomUUID();
    const activityIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: olderIssueId,
        companyId,
        title: "Older issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: commentIssueId,
        companyId,
        title: "Comment activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: activityIssueId,
        companyId,
        title: "Logged activity issue",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
    ]);

    await db.insert(issueComments).values({
      companyId,
      issueId: commentIssueId,
      body: "New comment without touching issue.updatedAt",
      createdAt: new Date("2026-03-26T11:00:00.000Z"),
      updatedAt: new Date("2026-03-26T11:00:00.000Z"),
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.document_updated",
        entityType: "issue",
        entityId: activityIssueId,
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
      },
      {
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "issue.read_marked",
        entityType: "issue",
        entityId: olderIssueId,
        createdAt: new Date("2026-03-26T13:00:00.000Z"),
      },
    ]);

    const result = await svc.list(companyId, {});

    expect(result.map((issue) => issue.id)).toEqual([
      activityIssueId,
      commentIssueId,
      olderIssueId,
    ]);
    expect(result.find((issue) => issue.id === activityIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T12:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === commentIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T11:00:00.000Z",
    );
    expect(result.find((issue) => issue.id === olderIssueId)?.lastActivityAt?.toISOString()).toBe(
      "2026-03-26T10:00:00.000Z",
    );
  });

  it("paginates earlier comments in descending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([firstCommentId]);
  });

  it("paginates later comments in ascending order from an anchor comment", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const firstCommentId = randomUUID();
    const anchorCommentId = randomUUID();
    const latestCommentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paged comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values([
      {
        id: firstCommentId,
        companyId,
        issueId,
        body: "First comment",
        createdAt: new Date("2026-03-26T10:00:00.000Z"),
        updatedAt: new Date("2026-03-26T10:00:00.000Z"),
      },
      {
        id: anchorCommentId,
        companyId,
        issueId,
        body: "Anchor comment",
        createdAt: new Date("2026-03-26T11:00:00.000Z"),
        updatedAt: new Date("2026-03-26T11:00:00.000Z"),
      },
      {
        id: latestCommentId,
        companyId,
        issueId,
        body: "Latest comment",
        createdAt: new Date("2026-03-26T12:00:00.000Z"),
        updatedAt: new Date("2026-03-26T12:00:00.000Z"),
      },
    ]);

    const comments = await svc.listComments(issueId, {
      afterCommentId: anchorCommentId,
      order: "asc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([latestCommentId]);
  });

  it("lists user comments when derived run attribution scans a timestamp window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comments issue",
      status: "todo",
      priority: "medium",
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      contextSnapshot: { issueId },
      createdAt: new Date("2026-05-12T22:58:00.000Z"),
      startedAt: new Date("2026-05-12T22:58:00.000Z"),
      finishedAt: new Date("2026-05-12T23:14:00.000Z"),
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Comment should be visible",
      createdAt: new Date("2026-05-12T23:00:00.000Z"),
      updatedAt: new Date("2026-05-12T23:00:00.000Z"),
    });

    const comments = await svc.listComments(issueId, {
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([commentId]);
    expect(comments[0]?.body).toBe("Comment should be visible");
  });

  it("lists user comments when a candidate attribution run log is missing", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Comments issue with missing run log",
      status: "todo",
      priority: "medium",
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      contextSnapshot: { issueId },
      createdAt: new Date("2026-05-12T22:58:00.000Z"),
      startedAt: new Date("2026-05-12T22:58:00.000Z"),
      finishedAt: new Date("2026-05-12T23:14:00.000Z"),
      logStore: "local_file",
      logRef: "missing/run-log.ndjson",
      logBytes: 128,
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "user-1",
      body: "Comment should still be visible",
      createdAt: new Date("2026-05-12T23:00:00.000Z"),
      updatedAt: new Date("2026-05-12T23:00:00.000Z"),
    });

    const comments = await svc.listComments(issueId, {
      order: "desc",
      limit: 50,
    });

    expect(comments.map((comment) => comment.id)).toEqual([commentId]);
    expect(comments[0]?.body).toBe("Comment should still be visible");
    expect(comments[0]?.metadata).toBeNull();
  });

  it("includes blockedBy summaries on list rows in one batched pass", async () => {
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const blockedId = randomUUID();
    const unblockedId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: unblockedId,
        companyId,
        title: "Unblocked issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    // `blockedBy` is conditionally spread when `includeBlockedBy: true`; the
    // service's inferred return type doesn't surface the optional field, so
    // widen here for the assertions.
    type WithBlockedBy = { id: string; blockedBy?: unknown };
    const defaultResult = (await svc.list(companyId)) as WithBlockedBy[];
    expect(defaultResult.find((issue) => issue.id === blockedId)?.blockedBy).toBeUndefined();

    const result = (await svc.list(companyId, { includeBlockedBy: true })) as WithBlockedBy[];
    const byId = new Map(result.map((issue) => [issue.id, issue]));

    expect(byId.get(blockedId)?.blockedBy).toEqual([
      expect.objectContaining({
        id: blockerId,
        identifier: null,
        title: "Blocker issue",
        status: "todo",
        priority: "high",
      }),
    ]);
    expect(byId.get(blockerId)?.blockedBy).toEqual([]);
    expect(byId.get(unblockedId)?.blockedBy).toEqual([]);
  });

  it("reports the same blocker set on list rows and single-issue reads", async () => {
    // Regression guard for BLO-19046. Two shapes taken from the field reports:
    // BLO-15080 (exactly one blocker) and BLO-18836 (two blockers). The failure
    // this pins is not a wrong array but a *missing* one: an absent `blockedBy`
    // deserializes to undefined, every `?? []` consumer renders that as "no
    // blockers", and triage inverts silently.
    const companyId = randomUUID();
    const singleBlockedId = randomUUID();
    const singleBlockerId = randomUUID();
    const doubleBlockedId = randomUUID();
    const doubleBlockerAId = randomUUID();
    const doubleBlockerBId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      { id: singleBlockerId, companyId, title: "H1 design dependency", status: "blocked", priority: "low" },
      { id: singleBlockedId, companyId, title: "H4 Rust PathMux port", status: "blocked", priority: "low" },
      { id: doubleBlockerAId, companyId, title: "Bearer provisioning", status: "in_progress", priority: "high" },
      { id: doubleBlockerBId, companyId, title: "Scope review", status: "todo", priority: "high" },
      { id: doubleBlockedId, companyId, title: "Track D TO bearer", status: "blocked", priority: "critical" },
    ]);

    await db.insert(issueRelations).values([
      { companyId, issueId: singleBlockerId, relatedIssueId: singleBlockedId, type: "blocks" },
      { companyId, issueId: doubleBlockerAId, relatedIssueId: doubleBlockedId, type: "blocks" },
      { companyId, issueId: doubleBlockerBId, relatedIssueId: doubleBlockedId, type: "blocks" },
    ]);

    type WithBlockedBy = { id: string; blockedBy?: Array<{ id: string }> };
    const ids = (rows?: Array<{ id: string }>) => [...(rows ?? [])].map((row) => row.id).sort();

    // The list must not silently claim emptiness when it simply did not hydrate.
    const unhydrated = (await svc.list(companyId)) as WithBlockedBy[];
    for (const row of unhydrated) {
      expect(row.blockedBy).toBeUndefined();
    }

    const hydrated = (await svc.list(companyId, { includeBlockedBy: true })) as WithBlockedBy[];
    const listById = new Map(hydrated.map((row) => [row.id, row]));

    for (const issueId of [singleBlockedId, doubleBlockedId, singleBlockerId]) {
      const fromList = ids(listById.get(issueId)?.blockedBy);
      const fromSingle = ids((await svc.getRelationSummaries(issueId)).blockedBy);
      expect(fromList).toEqual(fromSingle);
    }

    // And the sets are the expected non-empty ones, so the assertion above cannot
    // pass by both sides being empty.
    expect(ids(listById.get(singleBlockedId)?.blockedBy)).toEqual([singleBlockerId].sort());
    expect(ids(listById.get(doubleBlockedId)?.blockedBy)).toEqual([doubleBlockerAId, doubleBlockerBId].sort());
  });

  it("zeroes blockerAttention on non-blocked rows even when blockers exist", async () => {
    // BLO-19046: blockerAttention is computed only for rows whose status is
    // literally `blocked`; every other row gets an all-zero default. That zero
    // means "not computed", NOT "no blockers", and is the second silent-empty
    // trap in this family. Pinned so the semantics stay documented rather than
    // being mistaken for a summary of `blockedBy`.
    const companyId = randomUUID();
    const blockerId = randomUUID();
    const todoDependentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Real blocker", status: "todo", priority: "high" },
      { id: todoDependentId, companyId, title: "Dependent still in todo", status: "todo", priority: "high" },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: todoDependentId,
      type: "blocks",
    });

    type Row = { id: string; blockedBy?: Array<{ id: string }>; blockerAttention?: { unresolvedBlockerCount: number } };
    const rows = (await svc.list(companyId, { includeBlockedBy: true })) as Row[];
    const dependent = rows.find((row) => row.id === todoDependentId);

    // The blocker edge is real and `blockedBy` reports it...
    expect(dependent?.blockedBy?.map((row) => row.id)).toEqual([blockerId]);
    // ...while blockerAttention reports zero purely because status !== "blocked".
    expect(dependent?.blockerAttention?.unresolvedBlockerCount).toBe(0);
  });

  it("trims list payload fields that can grow large on issue index routes", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const longDescription = "x".repeat(5_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Large issue",
      description: longDescription,
      status: "todo",
      priority: "medium",
      executionPolicy: { stages: Array.from({ length: 20 }, (_, index) => ({ index, kind: "review", notes: "y".repeat(400) })) },
      executionState: { history: Array.from({ length: 20 }, (_, index) => ({ index, body: "z".repeat(400) })) },
      executionWorkspaceSettings: { notes: "w".repeat(2_000) },
    });

    const [result] = await svc.list(companyId);

    expect(result).toBeTruthy();
    expect(result?.description).toHaveLength(1200);
    expect(result?.executionPolicy).toBeNull();
    expect(result?.executionState).toBeNull();
    expect(result?.executionWorkspaceSettings).toBeNull();
  });

  it("does not let description preview truncation split multibyte characters", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const description = `${"x".repeat(1199)}— still valid after truncation`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Multibyte boundary issue",
      description,
      status: "todo",
      priority: "medium",
    });

    const [result] = await svc.list(companyId);

    expect(result?.description).toHaveLength(1200);
    expect(result?.description?.endsWith("—")).toBe(true);
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("BLO-18760: defaults projectId to the assignee's sole led project when no other workspace signal is present", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const issue = await svc.create(companyId, {
      title: "Board-filed issue with no project",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    expect(issue.projectId).toBe(projectId);
  });

  it("BLO-18760: leaves projectId null when the assignee leads no project", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "IC",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issue = await svc.create(companyId, {
      title: "Board-filed issue, no project anywhere",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    expect(issue.projectId).toBeNull();
  });

  it("BLO-18760: leaves projectId null when the assignee leads more than one project (ambiguous)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values([
      { id: randomUUID(), companyId, name: "Project A", status: "in_progress", leadAgentId: agentId },
      { id: randomUUID(), companyId, name: "Project B", status: "in_progress", leadAgentId: agentId },
    ]);

    const issue = await svc.create(companyId, {
      title: "Board-filed issue, ambiguous lead project",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    expect(issue.projectId).toBeNull();
  });

  it("BLO-18760: does not override an explicitly-provided projectId", async () => {
    const companyId = randomUUID();
    const ledProjectId = randomUUID();
    const explicitProjectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values([
      { id: ledProjectId, companyId, name: "Led project", status: "in_progress", leadAgentId: agentId },
      { id: explicitProjectId, companyId, name: "Explicit project", status: "in_progress" },
    ]);

    const issue = await svc.create(companyId, {
      title: "Explicitly-bound issue",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId: explicitProjectId,
    });

    expect(issue.projectId).toBe(explicitProjectId);
  });

  // Ally review (PR #811): the `== null` check treats an explicit `projectId: null`
  // identically to omitting the field. That is the intended contract, and it is the case
  // that actually matters -- the board/UI create path posts an explicit null, so if this
  // inferred nothing the BLO-18760 fix would never fire in production.
  it("BLO-18760: infers the led project when projectId is explicitly null (same as omitted)", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const issue = await svc.create(companyId, {
      title: "Board-filed issue posting an explicit null projectId",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId: null,
    });

    expect(issue.projectId).toBe(projectId);
  });

  // Ally review (PR #811): API clients may serialize nullable workspace fields as null.
  // Those nulls do not carry workspace intent and must not suppress the same root-create
  // project inference that `projectId: null` uses.
  it("BLO-18760: infers the led project when nullable workspace override fields are explicitly null", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const issue = await svc.create(companyId, {
      title: "Board-filed issue posting explicit null workspace fields",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      projectId: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
    });

    expect(issue.projectId).toBe(projectId);
  });

  // Ally review (PR #811) asked for explicit-null workspace fields to stop suppressing
  // sole-led-project inference. Applying that to the SHARED override predicate also
  // changed the two workspace-*inheritance* guards, which read the same three fields for
  // the opposite purpose: recovery/service.ts creates a liveness escalation parented to
  // the recovery issue and passes all three as null precisely so the escalation does NOT
  // adopt the blocker's checkout. Under the merged predicate the nulls stopped counting,
  // inheritance fired, and the escalation came out pinned to the parent's workspace with
  // preference "reuse_existing" (caught by heartbeat-issue-liveness-escalation.test.ts).
  // The two questions are now separate predicates; this pins the inheritance half so
  // they cannot be re-merged silently.
  it("BLO-18760: explicit null workspace fields still opt out of inheriting the parent's workspace", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const parentIssueId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Recovery issue holding a workspace",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "operator_branch" },
    });

    // Same field set the recovery escalation sends on its no-reuse branch.
    const escalation = await svc.create(companyId, {
      title: "Unblock liveness incident",
      status: "todo",
      priority: "high",
      parentId: parentIssueId,
      projectId,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: null,
    });

    expect(escalation.parentId).toBe(parentIssueId);
    expect(escalation.executionWorkspaceId).toBeNull();
    expect(escalation.executionWorkspacePreference).toBeNull();
  });

  // Ally review (PR #811): archival is the only exclusion, so an archived led project
  // must not be inferred even though it is the agent's sole lead.
  it("BLO-18760: excludes archived led projects from inference", async () => {
    const companyId = randomUUID();
    const archivedProjectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: archivedProjectId,
      companyId,
      name: "Archived project",
      status: "in_progress",
      leadAgentId: agentId,
      archivedAt: new Date(),
    });

    const issue = await svc.create(companyId, {
      title: "Issue whose assignee only leads an archived project",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    expect(issue.projectId).toBeNull();
  });

  // Ally review (PR #811): documents the deliberate other half of that policy -- project
  // status describes the work, not the repo, so a completed/paused project's checkout is
  // still a valid thing to inherit. Guards against someone "tightening" this to
  // status === "in_progress" and silently reopening the strand for finished projects.
  it("BLO-18760: still infers a completed (non-archived) led project", async () => {
    const companyId = randomUUID();
    const completedProjectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: completedProjectId,
      companyId,
      name: "Completed project",
      status: "completed",
      leadAgentId: agentId,
    });

    const issue = await svc.create(companyId, {
      title: "Issue whose assignee leads a completed project",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    expect(issue.projectId).toBe(completedProjectId);
  });

  // Ally review (PR #811, Important): the inference is scoped to ROOT creates. A child of
  // an intentionally-projectless parent must stay projectless -- inferring would split
  // parent and child across project, default goal, workspace policy, and repository, so
  // the child would quietly work against a different repo than the parent it reports into.
  // Both of the next two tests are needed: `parentId` and `workspaceInheritanceIssueId`
  // are independent signals, and the guard has to hold when only one of them is present.
  it("BLO-18760: leaves a child of a projectless parent projectless even when its assignee leads exactly one project", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    // Unassigned, so the root-create inference does not fire and the parent stays
    // genuinely projectless -- the precondition this test needs.
    const parent = await svc.create(companyId, {
      title: "Intentionally projectless parent",
      status: "todo",
    });
    expect(parent.projectId).toBeNull();

    const child = await svc.create(companyId, {
      parentId: parent.id,
      title: "Child of a projectless parent",
      status: "todo",
      assigneeAgentId: agentId,
    });

    expect(child.projectId).toBeNull();
  });

  // The `parentId == null` half of the guard is load-bearing on its own:
  // `skipExecutionWorkspaceInheritance` nulls `workspaceInheritanceIssueId` while a parent
  // still exists, which is exactly what the `inheritStrategyOnly` sub-issue path passes.
  // Guarding only on `workspaceInheritanceIssueId` (the literal review suggestion) would
  // let this case through.
  it("BLO-18760: leaves a child projectless when workspace inheritance is skipped but a parent exists", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const parent = await svc.create(companyId, {
      title: "Intentionally projectless parent (skip-inheritance)",
      status: "todo",
    });
    expect(parent.projectId).toBeNull();

    const child = await svc.create(companyId, {
      parentId: parent.id,
      title: "Child with inheritance skipped",
      status: "todo",
      assigneeAgentId: agentId,
      skipExecutionWorkspaceInheritance: true,
    });

    expect(child.projectId).toBeNull();
  });

  // The mirror case: no parent, but an explicit inheritance source. `parentId == null`
  // alone would let this through, so the `workspaceInheritanceIssueId` half is load-bearing
  // too.
  it("BLO-18760: leaves projectId null when inheriting from an explicit projectless source issue", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const source = await svc.create(companyId, {
      title: "Projectless workspace source",
      status: "todo",
    });
    expect(source.projectId).toBeNull();

    const issue = await svc.create(companyId, {
      title: "Issue inheriting from a projectless source",
      status: "todo",
      assigneeAgentId: agentId,
      inheritExecutionWorkspaceFromIssueId: source.id,
    });

    expect(issue.projectId).toBeNull();
  });

  // Ally review (PR #811): unlike a workspace *id* (whose project_id is NOT NULL, so the
  // blocks above always resolve a project from it), `executionWorkspacePreference` and
  // `executionWorkspaceSettings` express workspace intent without carrying a project --
  // they can reach the inference block with projectId still null. Inferring under them
  // would pull in the led project's default goal, project workspace and repository behind
  // the caller's back, and in the isolated_workspace case would turn a deliberate
  // WORKSPACE_WORKTREE_REQUIRES_PROJECT rejection into a silent success.
  //
  // Both cases need enableIsolatedWorkspaces: when the flag is off, create() deletes these
  // three fields outright, so hasExplicitExecutionWorkspaceOverride is already false and
  // the guard is inert by construction -- which is correct, since the same flag also gates
  // assertExplicitPinnedWorktreeIssueRunnable, so there is no rejection to preserve.
  it("BLO-18760: does not infer a led project when the caller pins executionWorkspaceSettings", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const issue = await svc.create(companyId, {
      title: "Pinned shared workspace, deliberately projectless",
      status: "todo",
      assigneeAgentId: agentId,
      executionWorkspaceSettings: { mode: "shared_workspace" },
    });

    expect(issue.projectId).toBeNull();
  });

  // The case with teeth: the assigned-agent variant of "rejects explicitly pinned isolated
  // git worktrees without a project or reusable workspace" below. Pre-guard, inference
  // supplied a projectId and this create SUCCEEDED, silently binding an explicitly
  // projectless worktree request to whichever project the assignee happened to lead.
  it("BLO-18760: still rejects a projectless isolated_workspace create for an assignee who leads one project", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    await expect(
      svc.create(companyId, {
        title: "Projectless worktree request",
        status: "todo",
        assigneeAgentId: agentId,
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
          workspaceStrategy: { type: "git_worktree" },
        },
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
      details: {
        code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
        remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
      },
    });
  });

  it("BLO-18760: does not infer a led project when the caller pins executionWorkspacePreference", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      status: "in_progress",
      leadAgentId: agentId,
    });

    const issue = await svc.create(companyId, {
      title: "Pinned workspace preference, deliberately projectless",
      status: "todo",
      assigneeAgentId: agentId,
      executionWorkspacePreference: "agent_default",
    });

    expect(issue.projectId).toBeNull();
  });

  it("inherits responsible user for agent-created child issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const responsibleUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parent = await svc.create(companyId, {
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: responsibleUserId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      responsibleUserId,
      contextSnapshot: { issueId: parent.id },
    });

    const child = await svc.create(companyId, {
      parentId: parent.id,
      title: "Agent-created child",
      createdByAgentId: agentId,
      actorRunId: runId,
    });

    expect(parent.responsibleUserId).toBe(responsibleUserId);
    expect(child.responsibleUserId).toBe(responsibleUserId);
  });

  it("only honors explicit responsibleUserId for trusted issue create callers", async () => {
    const companyId = randomUUID();
    const creatorUserId = randomUUID();
    const requestedResponsibleUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const untrusted = await svc.create(companyId, {
      title: "Untrusted explicit responsible user",
      createdByUserId: creatorUserId,
      responsibleUserId: requestedResponsibleUserId,
    });
    const trusted = await svc.create(companyId, {
      title: "Trusted explicit responsible user",
      createdByUserId: creatorUserId,
      responsibleUserId: requestedResponsibleUserId,
      trustExplicitResponsibleUserId: true,
    });

    expect(untrusted.responsibleUserId).toBe(creatorUserId);
    expect(trusted.responsibleUserId).toBe(requestedResponsibleUserId);
  });

  it("derives responsible user from authenticated actor context without trusting issue body", async () => {
    const companyId = randomUUID();
    const actorResponsibleUserId = randomUUID();
    const requestedResponsibleUserId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issue = await svc.create(companyId, {
      title: "Actor-context responsible user",
      responsibleUserId: requestedResponsibleUserId,
      actorResponsibleUserId,
    });

    expect(issue.responsibleUserId).toBe(actorResponsibleUserId);
  });

  it("does not stamp the assignee default environment onto new issues", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(issue.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("ignores legacy project environment selection when creating new issues", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const projectEnvironmentId = randomUUID();
    const assigneeEnvironmentId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: projectEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: assigneeEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA E2B Codex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      defaultEnvironmentId: assigneeEnvironmentId,
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
        environmentId: projectEnvironmentId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const issue = await svc.create(companyId, {
      projectId,
      assigneeAgentId,
      title: "Environment matrix: e2b / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(issue.executionWorkspaceSettings).toEqual({ mode: "shared_workspace" });
  });

  it("does not rewrite execution workspace settings on reassignment", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      {
        id: firstEnvironmentId,
        companyId,
        name: "QA SSH",
        driver: "ssh",
        status: "active",
        config: {},
      },
      {
        id: secondEnvironmentId,
        companyId,
        name: "QA E2B",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId,
        companyId,
        name: "QA SSH Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId,
        permissions: {},
      },
      {
        id: secondAgentId,
        companyId,
        name: "QA E2B Codex",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId,
        permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Environment matrix: ssh / codex_local",
      status: "todo",
      priority: "medium",
    });

    expect(created.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });

    expect(reassigned).not.toBeNull();
    expect(reassigned!.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("strips legacy environmentId values from execution workspace settings updates", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const firstEnvironmentId = randomUUID();
    const secondEnvironmentId = randomUUID();
    const operatorEnvironmentId = randomUUID();
    const firstAgentId = randomUUID();
    const secondAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(environments).values([
      { id: firstEnvironmentId, companyId, name: "Env 1", driver: "ssh", status: "active", config: {} },
      { id: secondEnvironmentId, companyId, name: "Env 2", driver: "sandbox", status: "active", config: { provider: "e2b" } },
      { id: operatorEnvironmentId, companyId, name: "Operator pick", driver: "ssh", status: "active", config: {} },
    ]);

    await db.insert(agents).values([
      {
        id: firstAgentId, companyId, name: "First agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: firstEnvironmentId, permissions: {},
      },
      {
        id: secondAgentId, companyId, name: "Second agent", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {},
        defaultEnvironmentId: secondEnvironmentId, permissions: {},
      },
    ]);

    await db.insert(projects).values({
      id: projectId, companyId, name: "Workspace project", status: "in_progress",
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "shared_workspace",
        allowIssueOverride: true,
        defaultProjectWorkspaceId: projectWorkspaceId,
      },
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary workspace", isPrimary: true,
    });

    const created = await svc.create(companyId, {
      projectId,
      assigneeAgentId: firstAgentId,
      title: "Operator overrides env then reassigns",
      status: "todo",
      priority: "medium",
    });

    const overridden = await svc.update(created.id, {
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        environmentId: operatorEnvironmentId,
      },
    });
    expect(overridden!.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });

    const reassigned = await svc.update(created.id, {
      assigneeAgentId: secondAgentId,
    });
    expect(reassigned!.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      projectId,
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("createChild applies parent defaults, acceptance criteria, workspace inheritance, and optional parent blocker chaining", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: 1,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const { issue: child, parentBlockerAdded } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      description: "Implement the helper.",
      acceptanceCriteria: ["Uses the parent issue as parentId", "Reuses the parent execution workspace"],
      blockParentUntilDone: true,
    });

    expect(parentBlockerAdded).toBe(true);
    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.goalId).toBe(goalId);
    expect(child.requestDepth).toBe(2);
    expect(child.description).toContain("## Acceptance Criteria");
    expect(child.description).toContain("- Uses the parent issue as parentId");
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");

    const parentRelations = await svc.getRelationSummaries(parentIssueId);
    expect(parentRelations.blockedBy).toEqual([
      expect.objectContaining({
        id: child.id,
        title: "Child helper",
      }),
    ]);
  });

  it("createChild preserves strategy-only workspace intent without realizing the parent workspace", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const environmentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Accepted plan parent",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId,
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "origin/master",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      },
    });

    const { issue: child } = await svc.createChild(parentIssueId, {
      title: "Accepted plan child",
      status: "todo",
      priority: "medium",
      executionWorkspaceInheritanceMode: "strategy_only",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBeNull();
    expect(child.executionWorkspacePreference).toBeNull();
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      environmentId,
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "origin/master",
        branchTemplate: "{{issue.identifier}}-{{slug}}",
      },
    });
  });

  it("clamps helper-created child requestDepth to the safe maximum", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const goalId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });

    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Ship child helpers",
      level: "task",
      status: "active",
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      goalId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      goalId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH,
    });

    const { issue: child } = await svc.createChild(parentIssueId, {
      title: "Child helper",
      status: "todo",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 100,
    });

    expect(child.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });
});

describeEmbeddedPostgres("issueService blockers and dependency wake readiness", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-blockers-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedSharedWorkspaceDependency() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    const foreignIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared workspace project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Shared workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Shared exec workspace",
      status: "active",
      providerType: "git_worktree",
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Predecessor",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: dependentId,
        companyId,
        projectId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: foreignIssueId,
        companyId,
        projectId,
        title: "Foreign in-flight issue",
        status: "in_progress",
        priority: "medium",
        executionWorkspaceId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    return {
      companyId,
      assigneeAgentId,
      projectId,
      projectWorkspaceId,
      executionWorkspaceId,
      blockerId,
      dependentId,
      foreignIssueId,
    };
  }

  it("persists blocked-by relations and exposes both blockedBy and blocks summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
      {
        id: blockedId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
      },
    ]);

    await svc.update(blockedId, {
      blockedByIssueIds: [blockerId],
    });

    const blockerRelations = await svc.getRelationSummaries(blockerId);
    const blockedRelations = await svc.getRelationSummaries(blockedId);

    expect(blockerRelations.blocks.map((relation) => relation.id)).toEqual([blockedId]);
    expect(blockedRelations.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
  });

  it("returns blocked-by summaries on newly created issues", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "high",
    });

    const created = await svc.create(companyId, {
      title: "Blocked issue",
      status: "blocked",
      priority: "medium",
      blockedByIssueIds: [blockerId],
    });

    expect(created.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
    expect(created.blockedBy[0]).toEqual(expect.objectContaining({
      title: "Blocker",
      status: "todo",
      priority: "high",
    }));
    expect(created.blocks).toEqual([]);
  });

  it("returns blocked-by summaries on newly created child issues", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const parentId = randomUUID();
    const blockerId = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockerId,
        companyId,
        title: "Blocker",
        status: "todo",
        priority: "high",
      },
    ]);

    const { issue: child } = await svc.createChild(parentId, {
      title: "Blocked child issue",
      status: "blocked",
      priority: "medium",
      blockedByIssueIds: [blockerId],
    });

    expect(child.parentId).toBe(parentId);
    expect(child.blockedBy.map((relation) => relation.id)).toEqual([blockerId]);
    expect(child.blocks).toEqual([]);
  });

  it("returns blocks summaries when child creation blocks the parent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const parentId = randomUUID();
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent",
      status: "todo",
      priority: "medium",
    });

    const { issue: child } = await svc.createChild(parentId, {
      title: "Parent-blocking child",
      status: "todo",
      priority: "medium",
      blockParentUntilDone: true,
    });

    expect(child.blocks.map((relation) => relation.id)).toEqual([parentId]);
    expect(child.blocks[0]).toEqual(expect.objectContaining({
      title: "Parent",
      status: "todo",
      priority: "medium",
    }));
    expect(child.blockedBy).toEqual([]);
  });

  it("adds terminal blockers to immediate blocked-by summaries", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    const issueC = randomUUID();
    const issueD = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, identifier: "PAP-1", title: "Issue A", status: "blocked", priority: "medium" },
      { id: issueB, companyId, identifier: "PAP-2", title: "Issue B", status: "blocked", priority: "medium" },
      { id: issueC, companyId, identifier: "PAP-3", title: "Issue C", status: "blocked", priority: "medium" },
      { id: issueD, companyId, identifier: "PAP-4", title: "Issue D", status: "todo", priority: "high" },
    ]);

    await svc.update(issueC, { blockedByIssueIds: [issueD] });
    await svc.update(issueB, { blockedByIssueIds: [issueC] });
    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    const relations = await svc.getRelationSummaries(issueA);

    expect(relations.blockedBy).toHaveLength(1);
    expect(relations.blockedBy[0]).toMatchObject({
      id: issueB,
      identifier: "PAP-2",
      title: "Issue B",
      terminalBlockers: [
        expect.objectContaining({
          id: issueD,
          identifier: "PAP-4",
          title: "Issue D",
          status: "todo",
          priority: "high",
        }),
      ],
    });
  });

  it("rejects blocking cycles", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(issues).values([
      { id: issueA, companyId, title: "Issue A", status: "todo", priority: "medium" },
      { id: issueB, companyId, title: "Issue B", status: "todo", priority: "medium" },
    ]);

    await svc.update(issueA, { blockedByIssueIds: [issueB] });

    await expect(
      svc.update(issueB, { blockedByIssueIds: [issueA] }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("only returns dependents once every blocker is done", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerA = randomUUID();
    const blockerB = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      { id: blockerA, companyId, title: "Blocker A", status: "done", priority: "medium" },
      { id: blockerB, companyId, title: "Blocker B", status: "todo", priority: "medium" },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);

    await svc.update(blockedIssueId, { blockedByIssueIds: [blockerA, blockerB] });

    expect(await svc.listWakeableBlockedDependents(blockerA)).toEqual([]);

    await svc.update(blockerB, { status: "done" });

    await expect(svc.listWakeableBlockedDependents(blockerA)).resolves.toEqual([
      expect.objectContaining({
        id: blockedIssueId,
        assigneeAgentId,
        blockerIssueIds: expect.arrayContaining([blockerA, blockerB]),
      }),
    ]);
  });

  describe("listWakeableBlockedDependents executive hold suppression (BLO-3496)", () => {
    async function setupBlockedDependentWithExecutive(opts: {
      ctoRole?: string;
    } = {}) {
      const companyId = randomUUID();
      const assigneeAgentId = randomUUID();
      const ctoAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: assigneeAgentId,
          companyId,
          name: "CodexCoder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: ctoAgentId,
          companyId,
          name: "CTO",
          role: opts.ctoRole ?? "cto",
          status: "active",
          adapterType: "claude_k8s",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      const blockerId = randomUUID();
      const blockedIssueId = randomUUID();
      await db.insert(issues).values([
        { id: blockerId, companyId, title: "Recovery", status: "done", priority: "critical" },
        {
          id: blockedIssueId,
          companyId,
          title: "Source under hold",
          status: "blocked",
          priority: "critical",
          assigneeAgentId,
        },
      ]);
      await svc.update(blockedIssueId, { blockedByIssueIds: [blockerId] });

      return { companyId, ctoAgentId, assigneeAgentId, blockerId, blockedIssueId };
    }

    async function insertComment(opts: {
      companyId: string;
      issueId: string;
      authorAgentId: string | null;
      body: string;
      createdAt: Date;
    }) {
      await db.insert(issueComments).values({
        id: randomUUID(),
        companyId: opts.companyId,
        issueId: opts.issueId,
        authorAgentId: opts.authorAgentId,
        body: opts.body,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
      });
    }

    it("suppresses the wake when an executive `do not retry before <future ts>` hold is active (strict ISO)", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Pausing — do not retry before ${future}.`,
        createdAt: new Date(),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([]);

      const after = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, ctx.blockedIssueId))
        .then((rows) => rows[0]);
      expect(after?.status).toBe("blocked");
    });

    it("suppresses the wake for the loose `YYYY-MM-DD HH:MM UTC` form too", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const yyyy = future.getUTCFullYear();
      const mm = String(future.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(future.getUTCDate()).padStart(2, "0");
      const hh = String(future.getUTCHours()).padStart(2, "0");
      const minute = String(future.getUTCMinutes()).padStart(2, "0");
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Hold this — do not retry before ${yyyy}-${mm}-${dd} ${hh}:${minute} UTC.`,
        createdAt: new Date(),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([]);
    });

    it("does NOT suppress when the executive hold timestamp is in the past", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Hold expired — do not retry before ${past}.`,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("does NOT suppress when the hold marker is from a non-executive author", async () => {
      const ctx = await setupBlockedDependentWithExecutive({ ctoRole: "engineer" });
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Trying to hold — do not retry before ${future}.`,
        createdAt: new Date(),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("does NOT suppress when there is no hold marker at all", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: "Just a status update from the CTO, no hold marker here.",
        createdAt: new Date(),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("suppresses the wake when the latest agent comment asks the user to pick an option", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.assigneeAgentId,
        body: "Please pick an option before work resumes.",
        createdAt: new Date(),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([]);
    });

    it("uses the newest matching executive comment when multiple holds are present", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const oldFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const newPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Initial hold — do not retry before ${oldFuture}.`,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Override — do not retry before ${newPast}.`,
        createdAt: new Date(),
      });

      await expect(svc.listWakeableBlockedDependents(ctx.blockerId)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });
  });

  describe("listResolvedBlockerDependentsToSweep executive hold suppression (BLO-3496)", () => {
    async function setupBlockedDependentWithExecutive(opts: {
      ctoRole?: string;
    } = {}) {
      const companyId = randomUUID();
      const assigneeAgentId = randomUUID();
      const ctoAgentId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values([
        {
          id: assigneeAgentId,
          companyId,
          name: "CodexCoder",
          role: "engineer",
          status: "active",
          adapterType: "codex_local",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
        {
          id: ctoAgentId,
          companyId,
          name: "CTO",
          role: opts.ctoRole ?? "cto",
          status: "active",
          adapterType: "claude_k8s",
          adapterConfig: {},
          runtimeConfig: {},
          permissions: {},
        },
      ]);

      const blockerId = randomUUID();
      const blockedIssueId = randomUUID();
      await db.insert(issues).values([
        { id: blockerId, companyId, title: "Recovery", status: "done", priority: "critical" },
        {
          id: blockedIssueId,
          companyId,
          title: "Source under hold",
          status: "blocked",
          priority: "critical",
          assigneeAgentId,
        },
      ]);
      await svc.update(blockedIssueId, { blockedByIssueIds: [blockerId] });

      return { companyId, ctoAgentId, assigneeAgentId, blockerId, blockedIssueId };
    }

    async function insertComment(opts: {
      companyId: string;
      issueId: string;
      authorAgentId: string | null;
      body: string;
      createdAt: Date;
    }) {
      await db.insert(issueComments).values({
        id: randomUUID(),
        companyId: opts.companyId,
        issueId: opts.issueId,
        authorAgentId: opts.authorAgentId,
        body: opts.body,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
      });
    }

    const sweepOpts = { minBlockerResolvedAge: { milliseconds: 0 } } as const;

    it("suppresses the sweep when an executive `do not retry before <future ts>` hold is active (strict ISO)", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Pausing — do not retry before ${future}.`,
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);

      const after = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, ctx.blockedIssueId))
        .then((rows) => rows[0]);
      expect(after?.status).toBe("blocked");
    });

    it("suppresses the sweep for the loose `YYYY-MM-DD HH:MM UTC` form too", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const yyyy = future.getUTCFullYear();
      const mm = String(future.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(future.getUTCDate()).padStart(2, "0");
      const hh = String(future.getUTCHours()).padStart(2, "0");
      const minute = String(future.getUTCMinutes()).padStart(2, "0");
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Hold this — do not retry before ${yyyy}-${mm}-${dd} ${hh}:${minute} UTC.`,
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);
    });

    it("does NOT suppress the sweep when the executive hold timestamp is in the past", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Hold expired — do not retry before ${past}.`,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("does NOT suppress the sweep when the hold marker is from a non-executive author", async () => {
      const ctx = await setupBlockedDependentWithExecutive({ ctoRole: "engineer" });
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Trying to hold — do not retry before ${future}.`,
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("does NOT suppress the sweep when there is no hold marker at all", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: "Just a status update from the CTO, no hold marker here.",
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("suppresses the sweep when the latest agent comment asks the user to pick an option", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.assigneeAgentId,
        body: "Please pick an option before work resumes.",
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);
    });

    it("does not treat BLO-18012's completed-work status report as awaiting user input", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.assigneeAgentId,
        body: "**CTO — bookkeeping confirmed, sequencing respected, one new live finding**\n\n**Attempted:** Verified BLO-18012 state per CEO's 17:34/17:37 comments before doing any further work.\n\n**Found:** State is exactly as CEO described — `in_progress`, workspace-bound (`projectId 584f37b3`, `executionWorkspaceId 575c743b`, shared_workspace/project_primary), and this very run (`8ef4da9d-da05-48f4-ad79-bc68215d6b6f`, locked 17:39:53Z) is executing cleanly in that workspace — no exit-128, confirming the BLO-18147 workspace-binding fix continues to hold for this issue specifically.\n\nNew finding while checking the shared checkout at `/paperclip/.../584f37b3.../paperclip` (same physical directory BLO-18147's live run 378f95f7 is also using): `git status` briefly showed **661 tracked files deleted from the working tree** (confirmed 3 samples missing from disk: `DESIGN.md`, `.github/workflows/release-verify.yml`, `packages/shared/src/types/tool-access.ts`), while the git index matched HEAD (nothing staged — no destructive-commit risk materialized). A concurrent `find`/`du` timed out at 2 min. ~90s later, re-checking: the files were back on disk and `git status` was clean. Transient, self-resolving, CephFS-backed PVC at 83% (850G/1.0T). Posted as evidence to [BLO-18147](https://paperclip.blockcast.net/BLO/issues/BLO-18147) since it's live corroboration for the storage-stress hypothesis there and for BLO-17793.\n\n**Next:** No further action needed on BLO-18012 itself this run — respecting the sequencing instruction (behind BLO-18141, BLO-18140, BLO-18147). Picking up BLO-18141 next per that stated order.",
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("uses the newest matching executive comment when multiple holds are present", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      const oldFuture = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const newPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Initial hold — do not retry before ${oldFuture}.`,
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Override — do not retry before ${newPast}.`,
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("suppresses the sweep when the dependent has a pending request confirmation", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, ctx.blockedIssueId));
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        kind: "request_confirmation",
        status: "pending",
        payload: { version: 1, prompt: "Confirm to proceed" },
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);
    });

    it("suppresses the sweep for in_review dependents even without a pending interaction", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, ctx.blockedIssueId));

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);
    });

    it("suppresses the sweep when the dependent has a pending linked approval", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, ctx.blockedIssueId));
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId: ctx.companyId,
        type: "issue_review",
        status: "pending",
        payload: {},
      });
      await db.insert(issueApprovals).values({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        approvalId,
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);
    });

    it("does NOT suppress the sweep for non-blocked candidates (todo/in_progress) regardless of hold marker", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      // Flip dependent to `todo`; an exec hold on a non-blocked candidate is meaningless to this sweep.
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, ctx.blockedIssueId));
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await insertComment({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        authorAgentId: ctx.ctoAgentId,
        body: `Hold marker — do not retry before ${future}.`,
        createdAt: new Date(),
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([
        expect.objectContaining({
          id: ctx.blockedIssueId,
          assigneeAgentId: ctx.assigneeAgentId,
        }),
      ]);
    });

    it("suppresses the sweep while a blocked issue has a pending request_confirmation", async () => {
      const ctx = await setupBlockedDependentWithExecutive();
      await db.insert(issueThreadInteractions).values({
        companyId: ctx.companyId,
        issueId: ctx.blockedIssueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "none",
        createdByAgentId: ctx.assigneeAgentId,
        payload: {
          version: 1,
          prompt: "Wait for human PR review?",
          target: {
            type: "custom",
            key: "github-pr-review",
            label: "PR review",
            href: "https://github.com/Blockcast/paperclip/pull/188",
          },
        },
      });

      await expect(svc.listResolvedBlockerDependentsToSweep(ctx.companyId, sweepOpts)).resolves.toEqual([]);
    });
  });

  it("does not sweep-wake a dependent whose sole blocker is done-but-unfinalized, and counts sweep_finalize_gated (BLO-13577)", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Sweep finalize-gate project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Sweep finalize-gate workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Sweep finalize-gate exec workspace",
      status: "active",
      providerType: "git_worktree",
    });

    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Predecessor",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
        completedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        id: dependentId,
        companyId,
        projectId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // The done blocker's workspace touched the finalize barrier but hasn't
    // recorded a successful workspace_finalize yet — same setup as the
    // fast-path test above, but exercised through the sweep this time.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-07-05T00:00:00.000Z"),
    });

    resetBlockerResolvedWakeMetrics();
    await expect(
      svc.listResolvedBlockerDependentsToSweep(companyId, { minBlockerResolvedAge: { milliseconds: 0 } }),
    ).resolves.toEqual([]);
    expect(getBlockerResolvedWakeMetric("sweep_finalize_gated")).toBe(1);

    // Once workspace_finalize succeeds, the sweep must surface the dependent.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-07-05T00:05:00.000Z"),
    });

    await expect(
      svc.listResolvedBlockerDependentsToSweep(companyId, { minBlockerResolvedAge: { milliseconds: 0 } }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
  });

  it("does NOT count/log sweep_finalize_gated when a dependent also has a wholly-unresolved blocker (Ally review on #602, BLO-13577)", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Sweep mixed-blocker project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Sweep mixed-blocker workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Sweep mixed-blocker exec workspace",
      status: "active",
      providerType: "git_worktree",
    });

    const finalizePendingBlockerId = randomUUID();
    const unresolvedBlockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      {
        id: finalizePendingBlockerId,
        companyId,
        projectId,
        title: "Done blocker awaiting finalize",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
        completedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        id: unresolvedBlockerId,
        companyId,
        projectId,
        title: "Wholly unresolved blocker",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: dependentId,
        companyId,
        projectId,
        title: "Dependent with mixed blockers",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, {
      blockedByIssueIds: [finalizePendingBlockerId, unresolvedBlockerId],
    });

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-07-05T00:00:00.000Z"),
    });

    // The dependent's other blocker isn't `done` at all, so the naive
    // "all blockers done by status" prefilter must exclude it before it ever
    // reaches the per-company readiness re-check — it must not be counted as
    // sweep_finalize_gated (the finalize barrier isn't the sole reason it's
    // stuck) nor as sweep_unresolved_gated (it never reaches that check).
    resetBlockerResolvedWakeMetrics();
    await expect(
      svc.listResolvedBlockerDependentsToSweep(companyId, { minBlockerResolvedAge: { milliseconds: 0 } }),
    ).resolves.toEqual([]);
    expect(getBlockerResolvedWakeMetric("sweep_finalize_gated")).toBe(0);
    expect(getBlockerResolvedWakeMetric("sweep_unresolved_gated")).toBe(0);
  });

  it("stops scanning once `limit` is reached and does not over-count sweep_finalize_gated past it (Ally review on #602, BLO-13577)", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const readyExecutionWorkspaceId = randomUUID();
    const gatedExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Sweep limit project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Sweep limit workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values([
      {
        id: readyExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Ready exec workspace",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: gatedExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Gated exec workspace",
        status: "active",
        providerType: "git_worktree",
      },
    ]);

    // Insertion (and, absent an ORDER BY on the candidate scan, observed scan)
    // order matters here: the ready dependent comes first so a fixed
    // implementation fills `limit` and stops before ever reaching the gated
    // dependents that follow it. The pre-fix code processed the whole company
    // regardless of `limit`, so it would have counted both gated dependents
    // (sweep_finalize_gated === 2) even though only 1 result was ever needed.
    const readyBlockerId = randomUUID();
    const readyDependentId = randomUUID();
    const gatedBlockerId = randomUUID();
    const gatedDependentId1 = randomUUID();
    const gatedDependentId2 = randomUUID();
    await db.insert(issues).values([
      {
        id: readyBlockerId,
        companyId,
        projectId,
        title: "Ready predecessor",
        status: "done",
        priority: "medium",
        executionWorkspaceId: readyExecutionWorkspaceId,
        completedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        id: readyDependentId,
        companyId,
        projectId,
        title: "Ready dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: gatedBlockerId,
        companyId,
        projectId,
        title: "Gated predecessor",
        status: "done",
        priority: "medium",
        executionWorkspaceId: gatedExecutionWorkspaceId,
        completedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        id: gatedDependentId1,
        companyId,
        projectId,
        title: "Gated dependent 1",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
      {
        id: gatedDependentId2,
        companyId,
        projectId,
        title: "Gated dependent 2",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(readyDependentId, { blockedByIssueIds: [readyBlockerId] });
    await svc.update(gatedDependentId1, { blockedByIssueIds: [gatedBlockerId] });
    await svc.update(gatedDependentId2, { blockedByIssueIds: [gatedBlockerId] });

    // Ready blocker's workspace fully finalized; gated blocker's workspace
    // only reached worktree_prepare (finalize barrier still open).
    await db.insert(workspaceOperations).values([
      {
        companyId,
        executionWorkspaceId: readyExecutionWorkspaceId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
      {
        companyId,
        executionWorkspaceId: readyExecutionWorkspaceId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date("2026-07-05T00:01:00.000Z"),
      },
      {
        companyId,
        executionWorkspaceId: gatedExecutionWorkspaceId,
        phase: "worktree_prepare",
        status: "succeeded",
        startedAt: new Date("2026-07-05T00:00:00.000Z"),
      },
    ]);

    resetBlockerResolvedWakeMetrics();
    const results = await svc.listResolvedBlockerDependentsToSweep(companyId, {
      limit: 1,
      minBlockerResolvedAge: { milliseconds: 0 },
    });
    expect(results).toEqual([
      expect.objectContaining({ id: readyDependentId, assigneeAgentId }),
    ]);
    expect(getBlockerResolvedWakeMetric("sweep_finalize_gated")).toBe(0);
  });

  it("gates dependents on the workspace-finalize barrier when a done blocker's execution workspace has not synced back", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared workspace project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Shared workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Shared exec workspace",
      status: "active",
      providerType: "git_worktree",
    });

    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        projectId,
        title: "Predecessor",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: dependentId,
        companyId,
        projectId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // A run touched the workspace (prepare phase) but has not yet recorded
    // workspace_finalize, so the dependent must not wake.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:00:00.000Z"),
    });

    // BLO-13250 (2026-07-05 recurrence): the readiness gate must count and log
    // this exclusion, not just silently return an empty candidate list — an
    // empty result and a genuinely-caught-up dependent were indistinguishable
    // before this counter existed.
    resetBlockerResolvedWakeMetrics();
    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);
    expect(getBlockerResolvedWakeMetric("fast_path_finalize_gated")).toBe(1);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
    });

    // A failed finalize must keep the gate closed.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "workspace_finalize",
      status: "failed",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });
    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);

    // Once a workspace_finalize succeeded row lands after the failed one, the
    // gate opens and the dependent is wakeable.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:10:00.000Z"),
    });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: true,
      pendingFinalizeBlockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
    });
  });

  it("does NOT count/log fast_path_finalize_gated when a dependent also has a wholly-unresolved blocker (Ally review, BLO-13250)", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Mixed-blocker project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Mixed-blocker workspace",
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Mixed-blocker exec workspace",
      status: "active",
      providerType: "git_worktree",
    });

    const finalizePendingBlockerId = randomUUID();
    const unresolvedBlockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      {
        id: finalizePendingBlockerId,
        companyId,
        projectId,
        title: "Done blocker awaiting finalize",
        status: "done",
        priority: "medium",
        executionWorkspaceId,
      },
      {
        id: unresolvedBlockerId,
        companyId,
        projectId,
        title: "Wholly unresolved blocker",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: dependentId,
        companyId,
        projectId,
        title: "Dependent with mixed blockers",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, {
      blockedByIssueIds: [finalizePendingBlockerId, unresolvedBlockerId],
    });

    // The done blocker's workspace touched the finalize barrier but hasn't
    // recorded a successful workspace_finalize yet.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-07-05T00:00:00.000Z"),
    });

    resetBlockerResolvedWakeMetrics();
    expect(await svc.listWakeableBlockedDependents(finalizePendingBlockerId)).toEqual([]);
    // The dependent is also stuck on a blocker that isn't `done` at all, so
    // the finalize gate is not the sole reason — must not be counted/logged
    // as `fast_path_finalize_gated`.
    expect(getBlockerResolvedWakeMetric("fast_path_finalize_gated")).toBe(0);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [finalizePendingBlockerId],
      unresolvedBlockerIssueIds: expect.arrayContaining([finalizePendingBlockerId, unresolvedBlockerId]),
    });
  });

  it("keeps dependents blocked on unattributed workspace operations for the blocker workspace", async () => {
    const {
      companyId,
      executionWorkspaceId,
      blockerId,
      dependentId,
    } = await seedSharedWorkspaceDependency();

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: null,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:00:00.000Z"),
    });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
    });

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: null,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: true,
      pendingFinalizeBlockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
    });
  });

  it("gates dependents on the blocker's own workspace-finalize barrier until sync-back succeeds", async () => {
    const {
      companyId,
      executionWorkspaceId,
      blockerId,
      dependentId,
      assigneeAgentId,
    } = await seedSharedWorkspaceDependency();

    // The blocker touched its workspace but has not yet recorded
    // workspace_finalize — the dependent must NOT wake.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerId,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:00:00.000Z"),
    });

    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: false,
      pendingFinalizeBlockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
    });

    // A failed finalize must keep the gate closed.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerId,
      phase: "workspace_finalize",
      status: "failed",
      startedAt: new Date("2026-05-23T22:05:00.000Z"),
    });
    expect(await svc.listWakeableBlockedDependents(blockerId)).toEqual([]);

    // Once a workspace_finalize succeeded row lands AFTER the failed one,
    // the gate opens and the dependent is wakeable.
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:10:00.000Z"),
    });
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: null,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-05-23T22:15:00.000Z"),
    });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      isDependencyReady: true,
      pendingFinalizeBlockerIssueIds: [],
    });
  });

  it("treats blockers with no executionWorkspaceId as not subject to the workspace-finalize barrier", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "QA",
      role: "qa",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      // Done blocker with no execution workspace ever attached (e.g. closed manually).
      { id: blockerId, companyId, title: "Manual done blocker", status: "done", priority: "medium" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // No executionWorkspaceId → no barrier → dependent should be wakeable.
    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId,
        blockerIssueIds: [blockerId],
      }),
    ]);
  });

  it("reports dependency readiness for blocked issue chains", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      { id: blockedId, companyId, title: "Blocked", status: "todo", priority: "medium" },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [blockerId],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });

    await svc.update(blockerId, { status: "done" });

    await expect(svc.getDependencyReadiness(blockedId)).resolves.toMatchObject({
      issueId: blockedId,
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
  });

  it("unblocks a source issue when a liveness escalation recovery issue is marked done", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const sourceIssueId = randomUUID();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: sourceIssueId,
        companyId,
        title: "Source issue",
        status: "blocked",
        priority: "medium",
      },
      {
        id: recoveryIssueId,
        companyId,
        title: "Liveness escalation issue",
        status: "in_progress",
        priority: "high",
        originKind: "harness_liveness_escalation",
        originId: `harness_liveness:${companyId}:${sourceIssueId}:invalid_review_participant:none`,
      },
    ]);

    await svc.update(sourceIssueId, {
      blockedByIssueIds: [recoveryIssueId],
    });
    await expect(svc.getRelationSummaries(sourceIssueId)).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: recoveryIssueId })],
    });

    await svc.update(recoveryIssueId, {
      status: "done",
    });

    await expect(svc.getRelationSummaries(sourceIssueId)).resolves.toMatchObject({
      blockedBy: [],
    });
  });

  it("rejects execution when unresolved blockers remain", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const blockerId = randomUUID();
    const blockedId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: blockedId,
        companyId,
        title: "Blocked",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      },
    ]);
    await svc.update(blockedId, { blockedByIssueIds: [blockerId] });

    await expect(
      svc.update(blockedId, { status: "in_progress" }),
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      svc.checkout(blockedId, assigneeAgentId, ["todo", "blocked"], null),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("allows a deliberate blocked to todo promotion when the latest agent comment awaits user input", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const commentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId,
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: assigneeAgentId,
      body: "Blocked awaiting Omar: @omar, can you pick a hostname for the preview deploy?",
      createdAt: new Date("2026-05-16T10:08:00.000Z"),
    });

    await expect(svc.update(issueId, { status: "todo" })).resolves.toMatchObject({
      id: issueId,
      status: "todo",
    });
  });

  it("allows blocked to todo promotion when the latest agent comment is not awaiting user input", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId,
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: assigneeAgentId,
      body: "Push permissions blocker is resolved; ready to resume.",
      createdAt: new Date("2026-05-16T10:08:00.000Z"),
    });

    const updated = await svc.update(issueId, { status: "todo" });

    expect(updated).toMatchObject({ id: issueId, status: "todo" });
  });

  it("allows blocked to todo promotion after a user replies to the agent question", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId,
    });
    await db.insert(issueComments).values([
      {
        companyId,
        issueId,
        authorAgentId: assigneeAgentId,
        body: "@omar, can you pick a hostname for the preview deploy?",
        createdAt: new Date("2026-05-16T10:08:00.000Z"),
      },
      {
        companyId,
        issueId,
        authorUserId: "omar",
        body: "Use ocm-preview.blockcast.network.",
        createdAt: new Date("2026-05-16T10:20:00.000Z"),
      },
    ]);

    const updated = await svc.update(issueId, { status: "todo" });

    expect(updated).toMatchObject({ id: issueId, status: "todo" });
  });

  it("lets a same-agent retry adopt the previous run ownership lock", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const previousRunId = randomUUID();
    const retryRunId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "QA Engineer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: previousRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "automation",
        contextSnapshot: { issueId },
      },
      {
        id: retryRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "automation",
        retryOfRunId: previousRunId,
        contextSnapshot: { issueId, retryOfRunId: previousRunId },
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Monitor issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: previousRunId,
      executionRunId: previousRunId,
      executionAgentNameKey: "qa engineer",
      executionLockedAt: new Date(),
    });

    await expect(svc.assertCheckoutOwner(issueId, assigneeAgentId, retryRunId)).resolves.toMatchObject({
      checkoutRunId: retryRunId,
      executionRunId: retryRunId,
      adoptedFromRunId: previousRunId,
    });

    await expect(svc.assertCheckoutOwner(issueId, otherAgentId, randomUUID())).rejects.toMatchObject({ status: 409 });
  });

  it("wakes parents only when all direct children are terminal", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const childA = randomUUID();
    const childB = randomUUID();
    // Set explicit issueNumbers so getWakeableParentAfterChildCompletion's
    // ORDER BY issue_number ASC, created_at ASC produces the deterministic
    // [childA, childB] ordering the assertion below expects. Without these,
    // both children get NULL issueNumber + identical created_at (single
    // INSERT statement → same now()) and Postgres returns them in an
    // arbitrary order.
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
        issueNumber: 1,
      },
      {
        id: childA,
        companyId,
        parentId,
        title: "Child A",
        status: "done",
        priority: "medium",
        issueNumber: 2,
      },
      {
        id: childB,
        companyId,
        parentId,
        title: "Child B",
        status: "blocked",
        priority: "medium",
        issueNumber: 3,
      },
    ]);

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();

    await svc.update(childB, { status: "cancelled" });

    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toMatchObject({
      id: parentId,
      assigneeAgentId,
      childIssueIds: [childA, childB],
      childIssueSummaries: [
        expect.objectContaining({ id: childA, title: "Child A", status: "done" }),
        expect.objectContaining({ id: childB, title: "Child B", status: "cancelled" }),
      ],
      childIssueSummaryTruncated: false,
    });
  });

  it("does not wake parent when all children are harness-generated system issues", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const parentId = randomUUID();
    const productivityReviewChildId = randomUUID();
    const staleActiveRunChildId = randomUUID();
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId,
        issueNumber: 1,
      },
      {
        id: productivityReviewChildId,
        companyId,
        parentId,
        title: "Productivity review",
        status: "done",
        priority: "medium",
        originKind: "issue_productivity_review",
        issueNumber: 2,
      },
      {
        id: staleActiveRunChildId,
        companyId,
        parentId,
        title: "Stale active run evaluation",
        status: "done",
        priority: "medium",
        originKind: "stale_active_run_evaluation",
        issueNumber: 3,
      },
    ]);

    // Both children are terminal (done) but system-harness-generated. They must
    // be filtered out of the wake-readiness check. The parent has no real
    // work-children, so we should not wake it. See PCL-2418.
    expect(await svc.getWakeableParentAfterChildCompletion(parentId)).toBeNull();
  });
});

describeEmbeddedPostgres("issueService.create workspace inheritance", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-create-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("inherits the parent issue workspace linkage when child workspace fields are omitted", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "workspace-key",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      providerRef: `/tmp/${executionWorkspaceId}`,
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceRuntime: { profile: "agent" },
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "isolated_workspace",
      workspaceRuntime: { profile: "agent" },
    });
  });

  it("preserves the parent project when a generic child create inherits workspace linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      title: "Generic child issue",
    });

    expect(child.parentId).toBe(parentIssueId);
    expect(child.projectId).toBe(projectId);
    expect(child.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(executionWorkspaceId);
  });

  it("rejects explicitly pinned isolated git worktrees without a project or reusable workspace", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await expect(svc.create(companyId, {
      title: "Projectless isolated worktree",
      status: "todo",
      priority: "medium",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree" },
      },
    })).rejects.toMatchObject({
      status: 422,
      message: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
      details: {
        code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
        remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
      },
    });
  });

  it("does not reject ambiguous inherited git-worktree settings before dispatch", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const issue = await svc.create(companyId, {
      title: "Ambiguous inherited worktree",
      status: "todo",
      priority: "medium",
      executionWorkspaceSettings: {
        mode: "inherit",
        workspaceStrategy: { type: "git_worktree" },
      },
    });

    expect(issue.executionWorkspaceSettings).toEqual({
      mode: "inherit",
      workspaceStrategy: { type: "git_worktree" },
    });
  });

  it("keeps explicit workspace fields instead of inheriting the parent linkage", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const parentIssueId = randomUUID();
    const parentProjectWorkspaceId = randomUUID();
    const parentExecutionWorkspaceId = randomUUID();
    const explicitProjectWorkspaceId = randomUUID();
    const explicitExecutionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values([
      {
        id: parentProjectWorkspaceId,
        companyId,
        projectId,
        name: "Parent workspace",
      },
      {
        id: explicitProjectWorkspaceId,
        companyId,
        projectId,
        name: "Explicit workspace",
      },
    ]);

    await db.insert(executionWorkspaces).values([
      {
        id: parentExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: parentProjectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Parent worktree",
        status: "active",
        providerType: "git_worktree",
      },
      {
        id: explicitExecutionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId: explicitProjectWorkspaceId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "Explicit shared workspace",
        status: "active",
        providerType: "local_fs",
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId,
      projectWorkspaceId: parentProjectWorkspaceId,
      title: "Parent issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId: parentExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
      },
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      projectId,
      title: "Child issue",
      projectWorkspaceId: explicitProjectWorkspaceId,
      executionWorkspaceId: explicitExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "shared_workspace",
      },
    });

    expect(child.projectWorkspaceId).toBe(explicitProjectWorkspaceId);
    expect(child.executionWorkspaceId).toBe(explicitExecutionWorkspaceId);
    expect(child.executionWorkspacePreference).toBe("reuse_existing");
    expect(child.executionWorkspaceSettings).toEqual({
      mode: "shared_workspace",
    });
  });

  it("inherits workspace linkage from an explicit source issue without creating a parent-child relationship", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "operator_branch",
      strategyType: "git_worktree",
      name: "Operator branch",
      status: "active",
      providerType: "git_worktree",
    });

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Source issue",
      status: "todo",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "operator_branch",
      },
    });

    const followUp = await svc.create(companyId, {
      title: "Follow-up issue",
      inheritExecutionWorkspaceFromIssueId: sourceIssueId,
    });

    expect(followUp.parentId).toBeNull();
    expect(followUp.projectId).toBe(projectId);
    expect(followUp.projectWorkspaceId).toBe(projectWorkspaceId);
    expect(followUp.executionWorkspaceId).toBe(executionWorkspaceId);
    expect(followUp.executionWorkspacePreference).toBe("reuse_existing");
    expect(followUp.executionWorkspaceSettings).toEqual({
      mode: "operator_branch",
    });
  });

  it("derives project identity when an update adds workspace linkage to a projectless issue", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Projectless issue",
      status: "todo",
      priority: "medium",
    });

    const updated = await svc.update(issueId, {
      projectWorkspaceId,
    });

    expect(updated?.projectId).toBe(projectId);
    expect(updated?.projectWorkspaceId).toBe(projectWorkspaceId);
  });

  it("rejects updates that pin a projectless issue to an isolated git worktree", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issue = await svc.create(companyId, {
      title: "Assign then isolate",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.update(issue.id, {
      assigneeAgentId: agentId,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        workspaceStrategy: { type: "git_worktree" },
      },
    })).rejects.toMatchObject({
      status: 422,
      message: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
      details: {
        code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
        remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
      },
    });
  });

  it("syncs reused execution workspace config when issue workspace settings are updated", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspace project",
      status: "in_progress",
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Issue worktree",
      status: "active",
      providerType: "git_worktree",
      metadata: {
        config: {
          environmentId: "env-old",
          provisionCommand: "bash ./scripts/provision-old.sh",
          teardownCommand: "bash ./scripts/teardown-old.sh",
          workspaceRuntime: { profile: "old" },
        },
      },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Recovery issue",
      status: "in_progress",
      priority: "medium",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: "env-old",
        workspaceStrategy: {
          type: "git_worktree",
          provisionCommand: "bash ./scripts/provision-old.sh",
          teardownCommand: "bash ./scripts/teardown-old.sh",
        },
        workspaceRuntime: { profile: "old" },
      },
    });

    await svc.update(issueId, {
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: "env-new",
        workspaceStrategy: {
          type: "cloud_sandbox",
          provisionCommand: "bash ./scripts/provision-new.sh",
          teardownCommand: "bash ./scripts/teardown-new.sh",
        },
        workspaceRuntime: { profile: "new" },
      },
    });

    const workspace = await db
      .select({ metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);

    expect(workspace?.metadata).toEqual({
      config: {
        environmentId: null,
        provisionCommand: "bash ./scripts/provision-new.sh",
        teardownCommand: "bash ./scripts/teardown-new.sh",
        cleanupCommand: null,
        workspaceRuntime: { profile: "new" },
        desiredState: null,
        serviceStates: null,
      },
    });
  });
});

describeEmbeddedPostgres("issueService.findMentionedProjectIds", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-mentioned-projects-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("can skip comment-body scans for bounded issue detail reads", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const titleProjectId = randomUUID();
    const commentProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values([
      {
        id: titleProjectId,
        companyId,
        name: "Title project",
        status: "in_progress",
      },
      {
        id: commentProjectId,
        companyId,
        name: "Comment project",
        status: "in_progress",
      },
    ]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Link [Title](${buildProjectMentionHref(titleProjectId)})`,
      description: null,
      status: "todo",
      priority: "medium",
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: `Comment link [Comment](${buildProjectMentionHref(commentProjectId)})`,
    });

    expect(await svc.findMentionedProjectIds(issueId, { includeCommentBodies: false })).toEqual([titleProjectId]);
    expect(await svc.findMentionedProjectIds(issueId)).toEqual([
      titleProjectId,
      commentProjectId,
    ]);
  });
});

describeEmbeddedPostgres("issueService.clearExecutionRunIfTerminal", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-execution-lock-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithRun(status: string | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = status ? randomUUID() : null;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (runId && status) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        invocationSource: "manual",
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Execution lock",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: runId ? "codexcoder" : null,
      executionLockedAt: runId ? new Date() : null,
    });

    return { issueId, runId };
  }

  it("clears execution locks owned by terminal runs", async () => {
    const { issueId } = await seedIssueWithRun("failed");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(true);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("does not clear execution locks owned by live runs", async () => {
    const { issueId, runId } = await seedIssueWithRun("running");

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(runId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not update issues without an execution lock", async () => {
    const { issueId } = await seedIssueWithRun(null);

    await expect(svc.clearExecutionRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({ executionRunId: issues.executionRunId, executionLockedAt: issues.executionLockedAt })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });
  });

  it("rejects checkout of a stale routine duplicate when another open issue owns the execution lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerIssueId = randomUUID();
    const duplicateIssueId = randomUUID();
    const ownerRunId = randomUUID();
    const checkoutRunId = randomUUID();
    const routineId = randomUUID();
    const dispatchFingerprint = "routine-dispatch-fingerprint";
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: ownerRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
    });
    await db.insert(issues).values([
      {
        id: ownerIssueId,
        companyId,
        title: "Owner routine execution",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: ownerRunId,
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: dispatchFingerprint,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: duplicateIssueId,
        companyId,
        title: "Stale duplicate routine execution",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: dispatchFingerprint,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    await expect(
      svc.checkout(duplicateIssueId, agentId, ["todo"], checkoutRunId),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        issueId: duplicateIssueId,
        ownerIssueId,
        ownerExecutionRunId: ownerRunId,
      },
    });

    const duplicateIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, duplicateIssueId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateIssue?.executionRunId).toBeNull();
  });

  it("returns a typed 422 (not generic 409) for assignee-owned in_review checkout with no active owner", async () => {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CTO",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Reproduction matrix (BLO-8454): status=in_review, assignee matches caller,
    // checkoutRunId=null, executionRunId=null.
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Awaiting review",
      status: "in_review",
      priority: "high",
      assigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
    });

    await expect(
      svc.checkout(issueId, assigneeAgentId, ["todo", "backlog", "blocked"], randomUUID()),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "issue_in_review_not_checkoutable", issueId },
    });

    // The rejected checkout must not mutate the issue out of review (no state-machine side effect).
    const after = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(after?.status).toBe("in_review");
    expect(after?.checkoutRunId).toBeNull();
    expect(after?.executionRunId).toBeNull();
  });

  it("does not clear checkout locks when a different execution run is live", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:06:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:06:00.000Z"),
    });

    await expect(svc.clearCheckoutRunIfTerminal(issueId)).resolves.toBe(false);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBe(failedRunId);
    expect(row?.executionRunId).toBe(runningRunId);
    expect(row?.executionAgentNameKey).toBe("codexcoder");
    expect(row?.executionLockedAt).toBeInstanceOf(Date);
  });

  it("does not let stale release clobber a successor checkout lock", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const releasingRunId = randomUUID();
    const successorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: releasingRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:06:00.000Z"),
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:07:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race stale release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:00:00.000Z"),
    });

    const [releaseResult, checkoutResult] = await Promise.allSettled([
      svc.release(issueId, agentId, releasingRunId),
      svc.checkout(issueId, agentId, ["todo", "in_progress"], successorRunId),
    ]);

    expect(checkoutResult.status).toBe("fulfilled");
    if (releaseResult.status === "rejected") {
      expect(releaseResult.reason).toMatchObject({ status: 409 });
    }

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: successorRunId,
      executionRunId: successorRunId,
    });
  });

  it("checkout refuses to promote a 'done' issue when 'done' is not in expectedStatuses, even with a lingering executionRunId pointer", async () => {
    // Regression for PR #2482 checkout-adoption review finding: the original
    // patch's stale-executionRunId adoption SQL set `status: 'in_progress'`
    // unconditionally, bypassing the caller's expectedStatuses guard. With the
    // guard restored, attempting to take over a 'done' issue with
    // expectedStatuses=['todo'] must fail and leave the row untouched.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const failedRunId = randomUUID();
    const successorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:07:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock on done issue",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:00:00.000Z"),
      completedAt: new Date("2026-06-10T10:01:00.000Z"),
    });

    await expect(svc.checkout(issueId, agentId, ["todo"], successorRunId))
      .rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "done",
      assigneeAgentId: agentId,
      checkoutRunId: null,
    });
  });

  it("checkout adoption of a stale checkoutRunId preserves the issue's assigneeUserId", async () => {
    // Regression for PR #2482 checkout-adoption review finding: any adoption
    // helper that re-locks an existing in_progress issue (e.g. when the prior
    // checkout/execution run is terminal) must not strip the row's
    // assigneeUserId. We exercise this via the adoptStaleCheckoutRun path,
    // which fires when checkoutRunId points at a terminal run while
    // executionRunId still points at a different, non-terminal run.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
    const issueId = randomUUID();
    const failedCheckoutRunId = randomUUID();
    const queuedExecutionRunId = randomUUID();
    const successorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedCheckoutRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date("2026-06-10T10:05:00.000Z"),
      },
      {
        id: queuedExecutionRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "manual",
      },
      {
        id: successorRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date("2026-06-10T10:07:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock with user co-assignee",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: userId,
      checkoutRunId: failedCheckoutRunId,
      executionRunId: queuedExecutionRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-06-10T10:00:00.000Z"),
    });

    const result = await svc.checkout(issueId, agentId, ["todo", "in_progress"], successorRunId);
    expect(result).toBeTruthy();

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: userId,
      checkoutRunId: successorRunId,
      executionRunId: successorRunId,
    });
  });
});

describeEmbeddedPostgres("accepted plan decomposition", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-accepted-plan-decomposition-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issuePlanDecompositions);
    await db.delete(issueThreadInteractions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAcceptedPlanContext() {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const assigneeAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Accepted plan decomposition",
      level: "task",
      status: "active",
    });

    return { companyId, goalId, assigneeAgentId };
  }

  async function seedAcceptedPlanIssue(args?: {
    companyId?: string;
    goalId?: string;
    assigneeAgentId?: string;
    sourceIssueId?: string;
    issueTitle?: string;
    workMode?: IssueWorkMode;
  }) {
    const companyId = args?.companyId ?? randomUUID();
    const goalId = args?.goalId ?? randomUUID();
    const assigneeAgentId = args?.assigneeAgentId ?? randomUUID();
    const sourceIssueId = args?.sourceIssueId ?? randomUUID();
    const planDocumentId = randomUUID();
    const acceptedPlanRevisionId = randomUUID();
    const acceptedInteractionId = randomUUID();

    if (!args?.companyId || !args?.goalId || !args?.assigneeAgentId) {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: false });
      await db.insert(agents).values({
        id: assigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(goals).values({
        id: goalId,
        companyId,
        title: "Accepted plan decomposition",
        level: "task",
        status: "active",
      });
    }

    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      goalId,
      title: args?.issueTitle ?? "Planning issue",
      status: "in_progress",
      priority: "medium",
      workMode: args?.workMode ?? "planning",
      assigneeAgentId: assigneeAgentId,
    });
    await db.insert(documents).values({
      id: planDocumentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "Plan body",
      latestRevisionId: acceptedPlanRevisionId,
      latestRevisionNumber: 1,
      createdByAgentId: assigneeAgentId,
      updatedByAgentId: assigneeAgentId,
    });
    await db.insert(documentRevisions).values({
      id: acceptedPlanRevisionId,
      companyId,
      documentId: planDocumentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      createdByAgentId: assigneeAgentId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId: sourceIssueId,
      documentId: planDocumentId,
      key: "plan",
    });
    await db.insert(issueThreadInteractions).values({
      id: acceptedInteractionId,
      companyId,
      issueId: sourceIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve this plan?",
        target: {
          type: "issue_document",
          issueId: sourceIssueId,
          documentId: planDocumentId,
          key: "plan",
          revisionId: acceptedPlanRevisionId,
          revisionNumber: 1,
        },
      },
      result: {
        version: 1,
        outcome: "accepted",
      },
      resolvedAt: new Date(),
      createdByUserId: "local-board",
      resolvedByUserId: "local-board",
    });

    return { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId };
  }

  async function getAcceptedPlanClaim(sourceIssueId: string) {
    return db
      .select()
      .from(issuePlanDecompositions)
      .where(eq(issuePlanDecompositions.sourceIssueId, sourceIssueId))
      .then((rows) => rows[0] ?? null);
  }

  it("reuses the same child issue set on repeat decomposition attempts for an accepted plan revision", async () => {
    const { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();

    const children = [
      {
        title: "Implement the claim table",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
        assigneeAgentId,
      },
      {
        title: "Add decomposition route tests",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const first = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });

    expect(first.decomposition).not.toHaveProperty("requestedChildren");
    expect(first.childIssueIds).toHaveLength(2);
    expect(first.newlyCreatedIssues).toHaveLength(2);
    expect(first.decomposition.status).toBe("completed");

    const second = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });

    expect(second.childIssueIds).toEqual(first.childIssueIds);
    expect(second.newlyCreatedIssues).toHaveLength(0);
    expect(second.decomposition.status).toBe("completed");

    const persistedClaims = await db
      .select()
      .from(issuePlanDecompositions)
      .where(eq(issuePlanDecompositions.sourceIssueId, sourceIssueId));
    expect(persistedClaims).toHaveLength(1);
    expect(persistedClaims[0]?.requestedChildCount).toBe(2);
    expect(persistedClaims[0]?.childIssueIds).toEqual(first.childIssueIds);

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.map((row) => row.id).sort()).toEqual([...first.childIssueIds].sort());

    const companyIssues = await svc.list(companyId, { parentId: sourceIssueId });
    expect(companyIssues).toHaveLength(2);
  });

  it("rejects a different child set for the same accepted plan fingerprint", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();

    await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Implement the claim table",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    await expect(svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Implement the claim table",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
        {
          title: "This duplicate should be rejected",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("allows accepted-plan decomposition on a standard-work issue with an accepted plan document", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue({
      workMode: "standard",
      issueTitle: "Implement after planning",
    });

    const result = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Implement the approved first slice",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    expect(result.childIssueIds).toHaveLength(1);
    expect(result.newlyCreatedIssues).toHaveLength(1);
    expect(result.decomposition.status).toBe("completed");
  });

  it("serializes concurrent accepted-plan retries for the same parent issue without duplicate children", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const children = [
      {
        title: "Persist exact-once decomposition claim",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
      {
        title: "Guard concurrent retry callers",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });
    const claim = await getAcceptedPlanClaim(sourceIssueId);
    expect(claim).not.toBeNull();

    for (const childIssueId of initial.childIssueIds) {
      await db.delete(issues).where(eq(issues.id, childIssueId));
    }
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [],
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const svcA = issueService(db);
    const svcB = issueService(db);
    const [first, second] = await Promise.all([
      svcA.decomposeAcceptedPlan(sourceIssueId, {
        acceptedPlanRevisionId,
        children,
        actorAgentId: assigneeAgentId,
      }),
      svcB.decomposeAcceptedPlan(sourceIssueId, {
        acceptedPlanRevisionId,
        children,
        actorAgentId: assigneeAgentId,
      }),
    ]);

    expect(first.childIssueIds).toEqual(second.childIssueIds);
    expect(first.childIssueIds).toHaveLength(2);
    expect(first.newlyCreatedIssues.length + second.newlyCreatedIssues.length).toBe(2);

    const persistedClaim = await getAcceptedPlanClaim(sourceIssueId);
    expect(persistedClaim?.status).toBe("completed");
    expect(persistedClaim?.childIssueIds).toEqual(first.childIssueIds);

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.map((row) => row.id).sort()).toEqual([...first.childIssueIds].sort());
  });

  it("rejects another planning parent's accepted revision even when both issues share the assignee", async () => {
    const { companyId, goalId, assigneeAgentId } = await seedAcceptedPlanContext();
    const firstIssue = await seedAcceptedPlanIssue({
      companyId,
      goalId,
      assigneeAgentId,
      issueTitle: "Earlier accepted plan",
    });
    const secondIssue = await seedAcceptedPlanIssue({
      companyId,
      goalId,
      assigneeAgentId,
      issueTitle: "Later accepted plan",
    });

    await svc.decomposeAcceptedPlan(firstIssue.sourceIssueId, {
      acceptedPlanRevisionId: firstIssue.acceptedPlanRevisionId,
      children: [
        {
          title: "Decompose the first issue only",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    await expect(svc.decomposeAcceptedPlan(secondIssue.sourceIssueId, {
      acceptedPlanRevisionId: firstIssue.acceptedPlanRevisionId,
      children: [
        {
          title: "This must not land on the second parent",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    })).rejects.toMatchObject({
      status: 422,
    });

    const secondIssueChildren = await db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.parentId, secondIssue.sourceIssueId));
    expect(secondIssueChildren).toHaveLength(0);
  });

  it("resumes partial child creation under the claimed fingerprint without duplicating completed children", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const children = [
      {
        title: "Create the first child once",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
      {
        title: "Recreate only the missing tail child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });
    const claim = await getAcceptedPlanClaim(sourceIssueId);
    expect(claim).not.toBeNull();

    const [firstChildId, secondChildId] = initial.childIssueIds;
    expect(firstChildId).toBeTruthy();
    expect(secondChildId).toBeTruthy();

    await db.delete(issues).where(eq(issues.id, secondChildId!));
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [firstChildId!],
        completedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const retried = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });

    expect(retried.decomposition.status).toBe("completed");
    expect(retried.childIssueIds[0]).toBe(firstChildId);
    expect(retried.newlyCreatedIssues).toHaveLength(1);
    expect(retried.newlyCreatedIssues[0]?.title).toBe("Recreate only the missing tail child");

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.some((row) => row.id === firstChildId)).toBe(true);
    expect(childrenRows.map((row) => row.title).sort()).toEqual(children.map((child) => child.title).sort());
  });

  it("resumes a partial decomposition after reassignment when only actor metadata changes", async () => {
    const { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const reassignedAgentId = randomUUID();
    await db.insert(agents).values({
      id: reassignedAgentId,
      companyId,
      name: "SecondCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const children = [
      {
        title: "Keep the original child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
        createdByAgentId: assigneeAgentId,
        actorAgentId: assigneeAgentId,
      },
      {
        title: "Create only the missing child after reassignment",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
        createdByAgentId: assigneeAgentId,
        actorAgentId: assigneeAgentId,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
    });
    const claim = await getAcceptedPlanClaim(sourceIssueId);
    const [firstChildId, secondChildId] = initial.childIssueIds;

    expect(claim).not.toBeNull();
    expect(firstChildId).toBeTruthy();
    expect(secondChildId).toBeTruthy();

    await db.delete(issues).where(eq(issues.id, secondChildId!));
    await db
      .update(issues)
      .set({ assigneeAgentId: reassignedAgentId, updatedAt: new Date() })
      .where(eq(issues.id, sourceIssueId));
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [firstChildId!],
        completedAt: null,
        ownerAgentId: assigneeAgentId,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const retried = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: children.map((child) => ({
        ...child,
        createdByAgentId: reassignedAgentId,
        actorAgentId: reassignedAgentId,
      })),
      actorAgentId: reassignedAgentId,
    });

    expect(retried.decomposition.status).toBe("completed");
    expect(retried.decomposition.ownerAgentId).toBe(reassignedAgentId);
    expect(retried.childIssueIds[0]).toBe(firstChildId);
    expect(retried.newlyCreatedIssues).toHaveLength(1);
    expect(retried.newlyCreatedIssues[0]?.title).toBe("Create only the missing child after reassignment");

    const childrenRows = await db
      .select({ id: issues.id, title: issues.title, createdByAgentId: issues.createdByAgentId })
      .from(issues)
      .where(eq(issues.parentId, sourceIssueId))
      .orderBy(asc(issues.createdAt), asc(issues.id));
    expect(childrenRows).toHaveLength(2);
    expect(childrenRows.map((row) => row.id).sort()).toEqual([...retried.childIssueIds].sort());
    expect(childrenRows.find((row) => row.id !== firstChildId)?.createdByAgentId).toBe(reassignedAgentId);
  });

  it("preserves the existing live claim owner when another actor resumes the same fingerprint", async () => {
    const { companyId, sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();
    const competingAgentId = randomUUID();
    const liveOwnerRunId = randomUUID();
    const competingRunId = randomUUID();
    await db.insert(agents).values({
      id: competingAgentId,
      companyId,
      name: "SecondCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: liveOwnerRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
      },
      {
        id: competingRunId,
        companyId,
        agentId: competingAgentId,
        status: "running",
        invocationSource: "manual",
      },
    ]);

    const children = [
      {
        title: "Keep the first created child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
      {
        title: "Create the missing second child",
        status: "todo" as const,
        workMode: "standard" as const,
        priority: "medium" as const,
      },
    ];

    const initial = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: assigneeAgentId,
      actorRunId: liveOwnerRunId,
    });
    const [firstChildId, secondChildId] = initial.childIssueIds;
    const claim = await getAcceptedPlanClaim(sourceIssueId);

    await db.delete(issues).where(eq(issues.id, secondChildId!));
    await db
      .update(issuePlanDecompositions)
      .set({
        status: "in_flight",
        childIssueIds: [firstChildId!],
        completedAt: null,
        ownerAgentId: assigneeAgentId,
        ownerRunId: liveOwnerRunId,
        updatedAt: new Date(),
      })
      .where(eq(issuePlanDecompositions.id, claim!.id));

    const retried = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children,
      actorAgentId: competingAgentId,
      actorRunId: competingRunId,
    });

    expect(retried.decomposition.status).toBe("completed");
    expect(retried.decomposition.ownerAgentId).toBe(assigneeAgentId);
    expect(retried.decomposition.ownerRunId).toBe(liveOwnerRunId);
  });

  it("lists persisted decompositions with child issue summaries", async () => {
    const { sourceIssueId, acceptedPlanRevisionId, assigneeAgentId } = await seedAcceptedPlanIssue();

    const initial = await svc.listAcceptedPlanDecompositions(sourceIssueId);
    expect(initial).toEqual([]);

    const result = await svc.decomposeAcceptedPlan(sourceIssueId, {
      acceptedPlanRevisionId,
      children: [
        {
          title: "Surface decomposition status in operator UI",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
        {
          title: "Add regression coverage",
          status: "todo",
          workMode: "standard",
          priority: "medium",
        },
      ],
      actorAgentId: assigneeAgentId,
    });

    const decompositions = await svc.listAcceptedPlanDecompositions(sourceIssueId);
    expect(decompositions).toHaveLength(1);
    const [record] = decompositions;
    expect(record?.status).toBe("completed");
    expect(record?.acceptedPlanRevisionId).toBe(acceptedPlanRevisionId);
    expect(record?.acceptedPlanRevisionNumber).toBeTypeOf("number");
    expect(record?.childIssues.map((child) => child.id).sort()).toEqual(
      [...result.childIssueIds].sort(),
    );
    expect(record).not.toHaveProperty("requestedChildren");
    expect(record?.childIssues.every((child) => typeof child.title === "string")).toBe(true);
  });
});

describeEmbeddedPostgres("issueService.assertCheckoutOwner stale checkout adoption", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-checkout-owner-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOwnershipIssue(params: {
    checkoutStatus: "running" | "failed" | "timed_out";
    actorRunStatus?: "running" | "failed" | "timed_out" | "succeeded";
    assigneeMatchesActor?: boolean;
  }) {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const actorAgentId = params.assigneeMatchesActor === false ? randomUUID() : assigneeAgentId;
    const staleRunId = randomUUID();
    const actorRunId = randomUUID();
    const issueId = randomUUID();
    const actorRunStatus = params.actorRunStatus ?? "running";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentRows = [
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer" as const,
        status: "active" as const,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ];
    if (actorAgentId !== assigneeAgentId) {
      agentRows.push({
        id: actorAgentId,
        companyId,
        name: "Actor",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(agents).values(agentRows);
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId: assigneeAgentId,
        status: params.checkoutStatus,
        invocationSource: "manual",
        finishedAt: params.checkoutStatus === "running" ? null : new Date(),
      },
      {
        id: actorRunId,
        companyId,
        agentId: actorAgentId,
        status: actorRunStatus,
        invocationSource: "manual",
        startedAt: actorRunStatus === "running" ? new Date() : null,
        finishedAt: actorRunStatus === "running" ? null : new Date(),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout owner recovery",
      status: "in_progress",
      priority: "high",
      assigneeAgentId,
      checkoutRunId: staleRunId,
      executionRunId: staleRunId,
      executionLockedAt: new Date(),
      executionAgentNameKey: "assignee",
    });

    return { issueId, assigneeAgentId, actorAgentId, staleRunId, actorRunId };
  }

  it("lets the current assignee adopt a stale terminal checkout owner", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed" });

    const ownership = await svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId);

    expect(ownership.checkoutRunId).toBe(seeded.actorRunId);
    expect(ownership.executionRunId).toBe(seeded.actorRunId);
    expect(ownership.adoptedFromRunId).toBeNull();
  });

  it("treats timed_out checkout owners as stale and recoverable", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "timed_out" });

    const ownership = await svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId);

    expect(ownership.checkoutRunId).toBe(seeded.actorRunId);
    expect(ownership.adoptedFromRunId).toBeNull();
  });

  it("does not allow non-assignees to adopt stale checkout ownership", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed", assigneeMatchesActor: false });

    await expect(
      svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("keeps live checkout owners protected with a 409 conflict", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "running" });

    await expect(
      svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("does not let terminal actor runs adopt stale checkout ownership", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed", actorRunStatus: "succeeded" });

    await expect(
      svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId),
    ).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("adopts unowned checkout after a concurrent stale-checkout clear wins the lock race", async () => {
    const seeded = await seedOwnershipIssue({ checkoutStatus: "failed" });
    await db
      .update(issues)
      .set({
        executionRunId: seeded.actorRunId,
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, seeded.issueId));

    const rowLocked = deferred<void>();
    const clearCanCommit = deferred<void>();

    const concurrentClear = db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${seeded.issueId} for update`,
      );
      rowLocked.resolve();
      await clearCanCommit.promise;
      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: seeded.actorRunId,
          executionLockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(issues.id, seeded.issueId));
    });

    await rowLocked.promise;

    const ownershipPromise = svc.assertCheckoutOwner(seeded.issueId, seeded.actorAgentId, seeded.actorRunId);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearCanCommit.resolve();
    await concurrentClear;

    const ownership = await ownershipPromise;
    expect(ownership.checkoutRunId).toBe(seeded.actorRunId);
    expect(ownership.executionRunId).toBe(seeded.actorRunId);
    expect(ownership.adoptedFromRunId).toBeNull();

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: seeded.actorRunId,
      executionRunId: seeded.actorRunId,
    });
  });

});
