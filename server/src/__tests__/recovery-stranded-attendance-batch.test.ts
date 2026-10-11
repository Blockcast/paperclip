import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateCompanyScopedTestState } from "./helpers/truncate-company-scoped-test-state.js";
import { recoveryService } from "../services/recovery/service.js";
import { createStrandedAttendancePrefetch } from "../services/recovery/stranded-attendance-prefetch.js";
import { PENDING_INTERACTION_MAX_AGE_MS } from "../services/recovery/issue-graph-liveness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PEN-3636: the batched attendance window answers the same question as the two
 * single-issue predicates it replaces, for the same rows.
 *
 * ⚠️ Why this file exists, and why the two static guards are not a substitute.
 * `recovery-attendance-prefetch-call-shape.test.ts` proves the batch and the
 * single-issue forms are COMPOSED FROM the same shared terms, and
 * `stranded-attendance-prefetch.test.ts` proves the windowing/TTL logic against a fake
 * loader. Neither executes the two SQL forms. Two queries built from identical terms can
 * still disagree — over a JSONB key that is absent rather than null, over an agent
 * filter applied in SQL on one side and in memory on the other, over a cutoff computed
 * once per window instead of once per candidate. Those are precisely the differences
 * this change introduces, and the only control for them is to run both and compare.
 *
 * The failure direction is what makes it worth an embedded Postgres: a batch that loses
 * a term answers "unattended" for real attendance, and "unattended" ends in an
 * ESCALATION — a mutation — where the correct answer would have been a deferral.
 *
 * Every case below is asserted as an EQUIVALENCE (batch === single-issue) and, second,
 * against a hand-declared expectation. The equivalence is the point; the expectation
 * stops both sides regressing together into agreeing on the wrong answer.
 */
describeEmbeddedPostgres("stranded attendance batch/single-issue equivalence (PEN-3636)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attendance-batch-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await truncateCompanyScopedTestState(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * The three predicates are closures inside `recoveryService` — deliberately, so they
   * sit beside the shared terms they compose. The construction-time seam is how a test
   * reaches them without hoisting them out and dissolving that adjacency.
   */
  type AttendancePredicates = Parameters<
    NonNullable<Parameters<typeof recoveryService>[1]["attendancePredicatesForTest"]>
  >[0];

  function attendancePredicates(): AttendancePredicates {
    const captured: AttendancePredicates[] = [];
    recoveryService(db, {
      enqueueWakeup: async () => null,
      attendancePredicatesForTest: (predicates) => {
        captured.push(predicates);
      },
    });
    const predicates = captured[0];
    if (!predicates) {
      throw new Error("recoveryService did not hand out the attendance predicates");
    }
    return predicates;
  }

  type Seeded = {
    companyId: string;
    foreignCompanyId: string;
    ownerAgentId: string;
    otherAgentId: string;
    issueIds: Record<string, string>;
  };

  async function insertCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `AB${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function insertAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
    });
    return agentId;
  }

  /**
   * One issue per attendance shape. The names are the shapes; the assertions table below
   * is keyed on them, so a case added here without an expectation is a missing key
   * rather than a silent pass.
   */
  const CASES = [
    "bare",
    "runningRunOwner",
    "queuedRunOther",
    "scheduledRetryRunOwner",
    "terminalRunOwner",
    "deferredWakeOwner",
    "nonDeferredWakeOwner",
    "runOwnerPlusWakeOther",
    "foreignCompanyRun",
    "runWithoutIssueIdKey",
    "freshPendingInteraction",
    "acceptPolicyInteraction",
    "nonWakePolicyInteraction",
    "answeredInteraction",
    "staleInteraction",
  ] as const;
  type CaseName = (typeof CASES)[number];

  async function seed(): Promise<Seeded> {
    const companyId = await insertCompany("Attendance Co");
    const foreignCompanyId = await insertCompany("Other Co");
    const ownerAgentId = await insertAgent(companyId, "Owner");
    const otherAgentId = await insertAgent(companyId, "Other");
    const foreignAgentId = await insertAgent(foreignCompanyId, "Foreign");

    const issueIds: Record<string, string> = {};
    let issueNumber = 100;
    for (const name of CASES) {
      const id = randomUUID();
      issueIds[name] = id;
      issueNumber += 1;
      await db.insert(issues).values({
        id,
        companyId,
        title: name,
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: ownerAgentId,
        issueNumber,
        identifier: `AB-${issueNumber}`,
      });
    }

    const run = (issueId: string | null, agentId: string, status: string, company = companyId) =>
      db.insert(heartbeatRuns).values({
        companyId: company,
        agentId,
        status,
        // `issueId` absent (not null) for the `runWithoutIssueIdKey` case: `->>` yields
        // SQL NULL for a missing key, which is the row shape the single-issue equality
        // would never return and the batch has to drop rather than record under a
        // falsy key.
        contextSnapshot: issueId ? { issueId } : { note: "no issue id" },
      });

    const wake = (issueId: string, agentId: string, status: string) =>
      db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "test",
        status,
        payload: { issueId },
      });

    const interaction = (
      issueId: string,
      status: string,
      continuationPolicy: string,
      createdAt: Date,
    ) =>
      db.insert(issueThreadInteractions).values({
        companyId,
        issueId,
        kind: "ask_user_questions",
        status,
        continuationPolicy,
        payload: {} as never,
        createdAt,
      });

    const now = Date.now();
    await run(issueIds.runningRunOwner!, ownerAgentId, "running");
    await run(issueIds.queuedRunOther!, otherAgentId, "queued");
    await run(issueIds.scheduledRetryRunOwner!, ownerAgentId, "scheduled_retry");
    await run(issueIds.terminalRunOwner!, ownerAgentId, "failed");
    await wake(issueIds.deferredWakeOwner!, ownerAgentId, "deferred_issue_execution");
    await wake(issueIds.nonDeferredWakeOwner!, ownerAgentId, "queued");
    await run(issueIds.runOwnerPlusWakeOther!, ownerAgentId, "running");
    await wake(issueIds.runOwnerPlusWakeOther!, otherAgentId, "deferred_issue_execution");
    // Same issue id, different company: only the company term can exclude it, and it
    // must do so on BOTH sides.
    await run(issueIds.foreignCompanyRun!, foreignAgentId, "running", foreignCompanyId);
    await run(null, ownerAgentId, "running");

    await interaction(issueIds.freshPendingInteraction!, "pending", "wake_assignee", new Date(now));
    await interaction(
      issueIds.acceptPolicyInteraction!,
      "pending",
      "wake_assignee_on_accept",
      new Date(now),
    );
    await interaction(issueIds.nonWakePolicyInteraction!, "pending", "none", new Date(now));
    await interaction(issueIds.answeredInteraction!, "answered", "wake_assignee", new Date(now));
    await interaction(
      issueIds.staleInteraction!,
      "pending",
      "wake_assignee",
      // One hour the wrong side of the 24 h bound, derived from the constant rather than
      // hardcoded so a change to the window moves this fixture with it.
      new Date(now - PENDING_INTERACTION_MAX_AGE_MS - 60 * 60 * 1000),
    );

    return { companyId, foreignCompanyId, ownerAgentId, otherAgentId, issueIds };
  }

  /**
   * Hand-declared truth per case: `[anyAgent, owner, other, pendingWakeInteraction]`.
   * `anyAgent` is the unfiltered predicate (a falsy `agentId`).
   */
  const EXPECTED: Record<CaseName, [boolean, boolean, boolean, boolean]> = {
    bare: [false, false, false, false],
    runningRunOwner: [true, true, false, false],
    queuedRunOther: [true, false, true, false],
    scheduledRetryRunOwner: [true, true, false, false],
    terminalRunOwner: [false, false, false, false],
    deferredWakeOwner: [true, true, false, false],
    nonDeferredWakeOwner: [false, false, false, false],
    // The union across both sources is what makes ONE window serve both the filtered and
    // the unfiltered form.
    runOwnerPlusWakeOther: [true, true, true, false],
    foreignCompanyRun: [false, false, false, false],
    runWithoutIssueIdKey: [false, false, false, false],
    freshPendingInteraction: [false, false, false, true],
    acceptPolicyInteraction: [false, false, false, true],
    nonWakePolicyInteraction: [false, false, false, false],
    answeredInteraction: [false, false, false, false],
    staleInteraction: [false, false, false, false],
  };

  /**
   * @param windowSize passed through to the prefetch. Run at both a window wide enough to
   *   hold every candidate and a window of 2, because a verdict that depends on how the
   *   candidate list was sliced is itself a drift the single-issue form cannot have.
   */
  async function assertEquivalent(seeded: Seeded, windowSize: number) {
    const { hasActiveExecutionPath, hasPendingWakeInteraction, readStrandedAttendanceWindow } =
      attendancePredicates();

    const candidates = CASES.map((name) => ({
      id: seeded.issueIds[name]!,
      companyId: seeded.companyId,
    }));
    const prefetch = createStrandedAttendancePrefetch(readStrandedAttendanceWindow, candidates, {
      windowSize,
      // Frozen: the TTL is wall-clock and embedded Postgres under parallel vitest can
      // exceed 5 s between candidates, which would reload mid-matrix and make a
      // disagreement unattributable. Same reasoning as `perPassMemoClockForTest`.
      now: () => 1_000,
    });

    for (const name of CASES) {
      const issueId = seeded.issueIds[name]!;
      const [expectedAny, expectedOwner, expectedOther, expectedInteraction] = EXPECTED[name];

      for (const [label, agentId, expected] of [
        ["unfiltered", null, expectedAny],
        ["owner", seeded.ownerAgentId, expectedOwner],
        ["other", seeded.otherAgentId, expectedOther],
      ] as const) {
        const single = await hasActiveExecutionPath(seeded.companyId, issueId, agentId);
        const batched = await prefetch.hasActiveExecutionPath(seeded.companyId, issueId, agentId);
        expect(
          batched,
          `${name}/${label}: batch disagrees with the single-issue predicate (window ${windowSize})`,
        ).toBe(single);
        expect(single, `${name}/${label}: single-issue predicate is not the declared truth`).toBe(
          expected,
        );
      }

      const singleInteraction = await hasPendingWakeInteraction(seeded.companyId, issueId);
      const batchedInteraction = await prefetch.hasPendingWakeInteraction(seeded.companyId, issueId);
      expect(
        batchedInteraction,
        `${name}: batch disagrees on pending wake interaction (window ${windowSize})`,
      ).toBe(singleInteraction);
      expect(singleInteraction, `${name}: pending wake interaction is not the declared truth`).toBe(
        expectedInteraction,
      );
    }
  }

  it("agrees with the single-issue predicates across every attendance shape", async () => {
    await assertEquivalent(await seed(), CASES.length + 8);
  }, 120_000);

  it("agrees regardless of how the candidate list is sliced into windows", async () => {
    await assertEquivalent(await seed(), 2);
  }, 120_000);

  it("returns an empty window for an empty id list without querying", async () => {
    // The early return is the one branch of the loader that no equivalence case reaches,
    // because the sweep never asks about zero candidates.
    const seeded = await seed();
    const { readStrandedAttendanceWindow } = attendancePredicates();
    const window = await readStrandedAttendanceWindow(seeded.companyId, []);
    expect(window.executionPath.size).toBe(0);
    expect(window.pendingWakeInteractionIssueIds.size).toBe(0);
  }, 120_000);
});
