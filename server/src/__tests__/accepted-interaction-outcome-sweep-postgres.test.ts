import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issuePullRequests,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  sweepAcceptedInteractionOutcomes,
  type AcceptedInteractionOutcomeBucket,
} from "../services/accepted-interaction-outcome-sweep.js";

/**
 * PEN-4409 — the half no pure test can reach: that the sweep's SQL actually
 * resolves a declared `expectedOutcome` against real rows.
 *
 * The sibling unit file pins the bucketing rules, and it would stay green if
 * this query matched NOTHING — every card would simply read `unobserved`, which
 * looks like a working alarm rather than a broken join. Two specific hazards are
 * only observable here, and both were real possibilities in the first draft:
 * the uuid/text case mismatch (`uuid::text` renders lowercase while the zod
 * `.uuid()` that admitted the declaration accepts uppercase) and the
 * company-scoping of the PR lookup.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    "Skipping embedded Postgres accepted-interaction outcome sweep tests on this host: "
    + (embeddedPostgresSupport.reason ?? "unsupported environment"),
  );
}

describeEmbeddedPostgres("sweepAcceptedInteractionOutcomes (PEN-4409)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-accepted-interaction-outcome-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE issue_thread_interactions, issue_pull_requests, issues, companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Carrier issue",
      status: "in_progress",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  async function insertAcceptedConfirmation(args: {
    companyId: string;
    issueId: string;
    payload: Record<string, unknown>;
    result?: Record<string, unknown> | null;
    kind?: string;
    status?: string;
    resolvedAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId: args.companyId,
      issueId: args.issueId,
      kind: args.kind ?? "request_confirmation",
      status: args.status ?? "accepted",
      continuationPolicy: "none",
      payload: { version: 1, prompt: "Authorise this", ...args.payload } as never,
      result: (args.result ?? { version: 1, outcome: "accepted" }) as never,
      resolvedAt: args.resolvedAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function bucketOf(interactionId: string): Promise<AcceptedInteractionOutcomeBucket | null> {
    const report = await sweepAcceptedInteractionOutcomes(db);
    for (const bucket of ["observed", "unobserved", "untracked", "acknowledged"] as const) {
      if (report.buckets[bucket].samples.some((s) => s.interactionId === interactionId)) return bucket;
    }
    return null;
  }

  it("reads a declared github_pr_merged outcome as observed once the merge is recorded", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "github_pr_merged",
          ref: { repoFullName: "Blockcast/paperclip", prNumber: 2584 },
        },
      },
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");

    await db.insert(issuePullRequests).values({
      companyId,
      issueId,
      repoFullName: "Blockcast/paperclip",
      prNumber: 2584,
      mergedAt: new Date(),
    });

    expect(await bucketOf(interactionId)).toBe("observed");
  });

  /**
   * The ambiguity that must never resolve toward the clear. `issue_pull_requests`
   * is webhook-fed and backfilled only for repos it has already seen, so no row
   * means "no record", not "not merged".
   */
  it("reads an unrecorded merge as unobserved rather than observed", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "github_pr_merged",
          ref: { repoFullName: "Blockcast/never-seen", prNumber: 1 },
        },
      },
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");
  });

  it("does not credit a merge recorded under a different company", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const other = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "github_pr_merged",
          ref: { repoFullName: "Blockcast/paperclip", prNumber: 2584 },
        },
      },
    });
    await db.insert(issuePullRequests).values({
      companyId: other.companyId,
      issueId: other.issueId,
      repoFullName: "Blockcast/paperclip",
      prNumber: 2584,
      mergedAt: new Date(),
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");
  });

  it("does not credit a PR that is recorded but not merged", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "github_pr_merged",
          ref: { repoFullName: "Blockcast/paperclip", prNumber: 2584 },
        },
      },
    });
    await db.insert(issuePullRequests).values({
      companyId,
      issueId,
      repoFullName: "Blockcast/paperclip",
      prNumber: 2584,
      mergedAt: null,
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");
  });

  it("reads a declared issue_status outcome as observed once the issue reaches it", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const targetId = randomUUID();
    await db.insert(issues).values({
      id: targetId,
      companyId,
      title: "Target",
      status: "todo",
      priority: "medium",
    });
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: { kind: "issue_status", ref: { issueId: targetId, status: "done" } },
      },
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");

    await db.execute(sql`UPDATE issues SET status = 'done' WHERE id = ${targetId}::uuid`);

    expect(await bucketOf(interactionId)).toBe("observed");
  });

  /**
   * `uuid::text` renders lowercase; the zod `.uuid()` that admits the
   * declaration accepts uppercase. Without the `lower()` in the query an
   * uppercase declaration is accepted at creation and then reads `unobserved`
   * forever — a permanent false finding manufactured entirely by formatting.
   */
  it("matches an issue_status reference declared in uppercase", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const targetId = randomUUID();
    await db.insert(issues).values({
      id: targetId,
      companyId,
      title: "Target",
      status: "done",
      priority: "medium",
    });
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "issue_status",
          ref: { issueId: targetId.toUpperCase(), status: "done" },
        },
      },
    });

    expect(await bucketOf(interactionId)).toBe("observed");
  });

  /**
   * "Reached at least this far", not "is sitting here right now". A bare
   * equality test reverted a card from `observed` to `unobserved` as soon as
   * the target moved PAST the declared status, which is the single most likely
   * way an `issue_status` card ends its life — and produced a permanent false
   * finding out of a genuinely completed action.
   */
  it("keeps an issue_status card observed after the target moves past the declared status", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const targetId = randomUUID();
    await db.insert(issues).values({
      id: targetId,
      companyId,
      title: "Target",
      status: "in_review",
      priority: "medium",
    });
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: { kind: "issue_status", ref: { issueId: targetId, status: "in_review" } },
      },
    });

    expect(await bucketOf(interactionId)).toBe("observed");

    await db.execute(sql`UPDATE issues SET status = 'done' WHERE id = ${targetId}::uuid`);

    expect(await bucketOf(interactionId)).toBe("observed");
  });

  it("does not treat a status short of the declared one as reached", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const targetId = randomUUID();
    await db.insert(issues).values({
      id: targetId,
      companyId,
      title: "Target",
      status: "todo",
      priority: "medium",
    });
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: { kind: "issue_status", ref: { issueId: targetId, status: "in_review" } },
      },
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");
  });

  /**
   * `blocked` and `cancelled` are off the progression ladder, so they satisfy
   * nothing and keep failing toward the alarm. A cancelled target is the
   * textbook moot card, and writing one off is a human judgement recorded
   * through the acknowledgement route — never an inference this sweep makes.
   */
  it.each(["blocked", "cancelled"])(
    "does not treat an off-ladder %s target as having reached the declared status",
    async (status) => {
      const { companyId, issueId } = await seedCompanyAndIssue();
      const targetId = randomUUID();
      await db.insert(issues).values({
        id: targetId,
        companyId,
        title: "Target",
        status: "in_progress",
        priority: "medium",
      });
      const interactionId = await insertAcceptedConfirmation({
        companyId,
        issueId,
        payload: {
          expectedOutcome: { kind: "issue_status", ref: { issueId: targetId, status: "in_review" } },
        },
      });
      await db.execute(sql`UPDATE issues SET status = ${status} WHERE id = ${targetId}::uuid`);

      expect(await bucketOf(interactionId)).toBe("unobserved");
    },
  );

  it("still matches an exact off-ladder status, which the ladder alone cannot express", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const targetId = randomUUID();
    await db.insert(issues).values({
      id: targetId,
      companyId,
      title: "Target",
      status: "blocked",
      priority: "medium",
    });
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: { kind: "issue_status", ref: { issueId: targetId, status: "blocked" } },
      },
    });

    expect(await bucketOf(interactionId)).toBe("observed");
  });

  /**
   * The clearing path (`acknowledged`), read out of `result`. An acceptance is
   * terminal, so a moot card could not be withdrawn and had no exit from
   * `unobserved` at all — and since the alert thresholds the OLDEST age in the
   * bucket, one such card pinned it on forever.
   */
  it("reads an acknowledgement recorded on result as the acknowledged bucket", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "github_pr_merged",
          ref: { repoFullName: "Blockcast/paperclip", prNumber: 2584 },
        },
      },
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");

    await db.execute(sql`
      UPDATE issue_thread_interactions
      SET result = jsonb_set(
        result,
        '{outcomeAcknowledgement}',
        ${JSON.stringify({
          acknowledgedAt: new Date().toISOString(),
          acknowledgedByUserId: "operator",
          reason: "superseded by #2601",
        })}::jsonb
      )
      WHERE id = ${interactionId}::uuid
    `);

    expect(await bucketOf(interactionId)).toBe("acknowledged");
  });

  it("clears an untracked card through acknowledgement as well", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {},
      result: {
        version: 1,
        outcome: "accepted",
        outcomeAcknowledgement: {
          acknowledgedAt: new Date().toISOString(),
          acknowledgedByUserId: "operator",
          reason: "ask is moot",
        },
      },
    });

    expect(await bucketOf(interactionId)).toBe("acknowledged");
  });

  it("reports an acceptance that declared nothing as untracked", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({ companyId, issueId, payload: {} });

    const report = await sweepAcceptedInteractionOutcomes(db);
    expect(report.buckets.untracked.count).toBe(1);
    expect(await bucketOf(interactionId)).toBe("untracked");
  });

  it("reads an unrecognised declared kind as unobserved, never observed", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: { expectedOutcome: { kind: "not_a_kind_this_build_knows", ref: {} } },
    });

    expect(await bucketOf(interactionId)).toBe("unobserved");
  });

  /**
   * A malformed reference must not take the sweep down. The query compares
   * references as TEXT precisely so a non-numeric `prNumber` cannot raise a cast
   * error and silence every bucket at once.
   */
  it("survives a malformed reference rather than failing the whole sweep", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: {
        expectedOutcome: {
          kind: "github_pr_merged",
          ref: { repoFullName: "Blockcast/paperclip", prNumber: "not-a-number" },
        },
      },
    });
    await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: { expectedOutcome: { kind: "issue_status", ref: { issueId: "nope", status: "done" } } },
    });

    const report = await sweepAcceptedInteractionOutcomes(db);
    expect(report.buckets.unobserved.count).toBe(2);
  });

  it("observes a tool-action card from its executed lifecycle, and only when executed", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const toolAction = {
      version: 1,
      actionRequestId: randomUUID(),
      invocationId: randomUUID(),
      toolName: "writeThing",
      toolDisplayName: "Write Thing",
      connectionId: null,
      applicationId: null,
      appDisplayName: null,
      risk: "write",
      previewMarkdown: "writes a thing",
      argumentsSummaryJson: "{}",
      argumentsHash: "abc",
      expiresAt: new Date().toISOString(),
    };
    const executed = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: { toolAction },
      result: {
        version: 1,
        outcome: "accepted",
        toolAction: { version: 1, status: "executed", updatedAt: new Date().toISOString() },
      },
    });
    const failed = await insertAcceptedConfirmation({
      companyId,
      issueId,
      payload: { toolAction },
      result: {
        version: 1,
        outcome: "accepted",
        toolAction: { version: 1, status: "failed", updatedAt: new Date().toISOString() },
      },
    });

    expect(await bucketOf(executed)).toBe("observed");
    expect(await bucketOf(failed)).toBe("unobserved");
    const report = await sweepAcceptedInteractionOutcomes(db);
    expect(report.buckets.untracked.count).toBe(0);
  });

  it("ignores interactions that are not accepted confirmations", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    await insertAcceptedConfirmation({ companyId, issueId, payload: {}, status: "pending" });
    await insertAcceptedConfirmation({ companyId, issueId, payload: {}, status: "rejected" });
    // `suggest_tasks` acceptance creates its issues in the same transaction and
    // records them in `result.createdTasks`, so it is not in the class this
    // sweep measures.
    await insertAcceptedConfirmation({ companyId, issueId, payload: {}, kind: "suggest_tasks" });

    const report = await sweepAcceptedInteractionOutcomes(db);
    const total = report.buckets.observed.count
      + report.buckets.unobserved.count
      + report.buckets.untracked.count;
    expect(total).toBe(0);
  });

  it("includes request_checkbox_confirmation in the population", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({
      companyId,
      issueId,
      kind: "request_checkbox_confirmation",
      payload: { options: [{ id: "a", label: "A" }] },
    });

    expect(await bucketOf(interactionId)).toBe("untracked");
  });

  /** The sweep reports; it must never act on a board decision. */
  it("leaves every interaction row untouched", async () => {
    const { companyId, issueId } = await seedCompanyAndIssue();
    const interactionId = await insertAcceptedConfirmation({ companyId, issueId, payload: {} });
    const before = await db.execute(sql`
      SELECT status, result, updated_at FROM issue_thread_interactions WHERE id = ${interactionId}::uuid
    `);

    await sweepAcceptedInteractionOutcomes(db);

    const after = await db.execute(sql`
      SELECT status, result, updated_at FROM issue_thread_interactions WHERE id = ${interactionId}::uuid
    `);
    expect(JSON.stringify(after)).toEqual(JSON.stringify(before));
  });
});
