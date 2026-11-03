import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

/**
 * PEN-5351 (PEN-5342 follow-up).
 *
 * `issues.execution_agent_name_key` is the name half of the (run id, agent name)
 * pair that identifies the execution-lock holder. Two writers wrote the pair —
 * `runningCheckoutExecutionPatch` and the heartbeat claim. The four `adopt*`
 * writers moved `execution_run_id` alone and left whatever name the PREVIOUS
 * holder put there, so the row read "run <new holder>" beside
 * "agent <previous holder>" and every reader that trusts the column named a
 * foreign seat as the owner of the reader's own sibling run.
 *
 * ⛔ The thing under test is THE COLUMN AFTER ADOPTION, not that a write
 * happened. The defect was invisible precisely because the adoption succeeded:
 * `execution_run_id` moved, the caller got its ownership row back, and nothing
 * anywhere read the name half. So every case below drives a REAL adoption
 * through `assertCheckoutOwner` — the production entry point for all four
 * writers — against a row pre-stamped with a DIFFERENT agent's name, and then
 * asserts the persisted column. Asserting the adoption's return value instead
 * would pass against the pre-fix code, which is the whole point.
 *
 * Each case names which of the four writers it reaches, and reaches it by the
 * branch conditions in `assertCheckoutOwner`'s `resolveOwnership`, not by
 * calling the private helper.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping adoption agent-name-key DB tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("adoption co-writes executionAgentNameKey (PEN-5351)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-adoption-name-key-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 180_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    contextSnapshot?: Record<string, unknown>;
    createdAt?: Date;
    startedAt?: Date | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status,
      contextSnapshot: input.contextSnapshot ?? {},
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    });
    return runId;
  }

  /**
   * The seat that previously held the lock. The scenario is not contrived: the
   * heartbeat claim can hand the execution lock to an execution-review
   * participant who is NOT the assignee, and that claim DOES stamp the name —
   * so "devops" here is a name a correct writer wrote, left behind by an
   * incorrect one.
   */
  const PREVIOUS_HOLDER_NAME_KEY = "devops";

  async function seedContendedIssue(input: {
    /**
     * Status of the previous holder's run, or null to seed no previous holder
     * at all. `queued` with a null `started_at` is the never-started shape.
     */
    previousHolderRunStatus: string | null;
    /** Whether `checkout_run_id` points at that previous-holder run. */
    checkoutHeldByPreviousHolder: boolean;
    /** Whether `execution_run_id` points at that previous-holder run. */
    executionHeldByPreviousHolder: boolean;
    /** `contextSnapshot` of the adopting run — gates `isActiveActorRunForIssue`. */
    actorNamesIssueInContext: boolean;
  }) {
    const companyId = await seedCompany();
    const assigneeAgentId = await seedAgent(companyId, "Engineer");
    const previousHolderAgentId = await seedAgent(companyId, "DevOps");
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Contended issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
    });

    // A never-started owner must carry a null `started_at`, or it is not
    // reapable. It also decides WHAT the pre-fix residue is, which is why these
    // fixtures use it: `assertCheckoutOwner` opens with
    // `clearTerminalIssueRunLocksPair`, and that sweep nulls the name — so with
    // a TERMINAL previous holder the pre-fix column is merely ABSENT. A
    // never-started holder is not swept, so its name survives the adoption
    // literally, which is the "run <new holder> / agent <previous holder>" row
    // PEN-5351 describes.
    const previousHolderNeverStarted = input.previousHolderRunStatus === "queued"
      || input.previousHolderRunStatus === "scheduled_retry";
    const previousHolderRunId = input.previousHolderRunStatus !== null
      ? await seedRun({
          companyId,
          agentId: previousHolderAgentId,
          status: input.previousHolderRunStatus,
          contextSnapshot: { issueId },
          createdAt: new Date(Date.now() - 60_000),
          startedAt: previousHolderNeverStarted ? null : new Date(Date.now() - 60_000),
        })
      : null;

    const actorRunId = await seedRun({
      companyId,
      agentId: assigneeAgentId,
      status: "running",
      contextSnapshot: input.actorNamesIssueInContext ? { issueId } : {},
      createdAt: new Date(),
      startedAt: new Date(),
    });

    // Pre-stamp the stale name. This is the state the four writers left behind:
    // a name that described the PREVIOUS holder and was never cleared.
    await db
      .update(issues)
      .set({
        checkoutRunId: input.checkoutHeldByPreviousHolder ? previousHolderRunId : null,
        executionRunId: input.executionHeldByPreviousHolder ? previousHolderRunId : null,
        executionAgentNameKey: PREVIOUS_HOLDER_NAME_KEY,
        executionLockedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(issues.id, issueId));

    return { companyId, issueId, assigneeAgentId, previousHolderAgentId, previousHolderRunId, actorRunId };
  }

  async function readLock(issueId: string) {
    return db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  it("adoptStaleCheckoutRun: the reachable failure — the reviewer's name must not survive the assignee's adoption", async () => {
    // checkout_run_id and execution_run_id both point at the previous holder's
    // now-terminal run, which is the shape `adoptStaleCheckoutRun` handles and
    // the one the PEN-5351 narrative describes. That function carries no agent
    // check at all, so before the fix the row came out of this adoption reading
    // run=<assignee's run> / agent="devops".
    const { issueId, assigneeAgentId, actorRunId, previousHolderRunId } = await seedContendedIssue({
      previousHolderRunStatus: "queued",
      checkoutHeldByPreviousHolder: true,
      executionHeldByPreviousHolder: true,
      actorNamesIssueInContext: true,
    });

    await svc.assertCheckoutOwner(issueId, assigneeAgentId, actorRunId);

    const lock = await readLock(issueId);
    expect(lock?.executionRunId, "adoption must have moved the lock").toBe(actorRunId);
    expect(lock?.executionRunId).not.toBe(previousHolderRunId);
    expect(
      lock?.executionAgentNameKey,
      "the column must name the agent whose run now holds the lock, not the previous holder",
    ).toBe("engineer");
    expect(lock?.executionAgentNameKey).not.toBe(PREVIOUS_HOLDER_NAME_KEY);
  });

  it("adoptUnownedCheckoutRun: an unowned checkout must not inherit the last holder's name", async () => {
    const { issueId, assigneeAgentId, actorRunId } = await seedContendedIssue({
      previousHolderRunStatus: null,
      checkoutHeldByPreviousHolder: false,
      executionHeldByPreviousHolder: false,
      actorNamesIssueInContext: true,
    });

    await svc.assertCheckoutOwner(issueId, assigneeAgentId, actorRunId);

    const lock = await readLock(issueId);
    expect(lock?.executionRunId).toBe(actorRunId);
    expect(lock?.executionAgentNameKey).toBe("engineer");
  });

  it("adoptActiveActorIssueRun: superseding a reapable execution owner restamps the name", async () => {
    // checkout_run_id null + a reapable foreign execution owner + an actor run
    // that names the issue in its context is the branch that reaches
    // `adoptActiveActorIssueRun`.
    const { issueId, assigneeAgentId, actorRunId, previousHolderRunId } = await seedContendedIssue({
      previousHolderRunStatus: "queued",
      checkoutHeldByPreviousHolder: false,
      executionHeldByPreviousHolder: true,
      actorNamesIssueInContext: true,
    });

    await svc.assertCheckoutOwner(issueId, assigneeAgentId, actorRunId);

    const lock = await readLock(issueId);
    expect(lock?.executionRunId).toBe(actorRunId);
    expect(lock?.executionRunId).not.toBe(previousHolderRunId);
    expect(lock?.executionAgentNameKey).toBe("engineer");
  });

  it("adoptStaleExecutionLock: clearing then re-taking a stale lock restamps the name", async () => {
    // Same row shape as the case above, except the actor run does NOT name the
    // issue in its context snapshot — so `isActiveActorRunForIssue` is false,
    // `adoptActiveActorIssueRun` declines, and the fall-through reaches
    // `adoptStaleExecutionLock`. That path clears the columns (setting the name
    // to null) and then re-takes them in a second statement, which is where the
    // name has to be written back. So unlike the three cases above, the pre-fix
    // residue here is an ABSENT name rather than the previous holder's — the
    // column goes silent about a holder it could name. Both are fixed by the
    // same co-write; only this one was never a confident wrong answer.
    const { issueId, assigneeAgentId, actorRunId } = await seedContendedIssue({
      previousHolderRunStatus: "queued",
      checkoutHeldByPreviousHolder: false,
      executionHeldByPreviousHolder: true,
      actorNamesIssueInContext: false,
    });

    await svc.assertCheckoutOwner(issueId, assigneeAgentId, actorRunId);

    const lock = await readLock(issueId);
    expect(lock?.executionRunId).toBe(actorRunId);
    expect(lock?.checkoutRunId).toBe(actorRunId);
    expect(lock?.executionAgentNameKey).toBe("engineer");
  });

  it("writes the name of the agent that owns the ADOPTING RUN, not merely a non-stale one", async () => {
    // Negative control for the assertions above. A fix that hard-coded any
    // single value, or that wrote the assignee's name without consulting the
    // run row, would satisfy every case above — they all adopt on behalf of an
    // agent named "Engineer". Here the assignee is named something else, so
    // "engineer" is now the WRONG answer and only a value read off the adopting
    // run's agent passes.
    const companyId = await seedCompany();
    const assigneeAgentId = await seedAgent(companyId, "Security Engineer");
    const previousHolderAgentId = await seedAgent(companyId, "DevOps");
    const issueId = randomUUID();

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Contended issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
    });
    const previousHolderRunId = await seedRun({
      companyId,
      agentId: previousHolderAgentId,
      status: "queued",
      contextSnapshot: { issueId },
      createdAt: new Date(Date.now() - 60_000),
      startedAt: null,
    });
    const actorRunId = await seedRun({
      companyId,
      agentId: assigneeAgentId,
      status: "running",
      contextSnapshot: { issueId },
      createdAt: new Date(),
      startedAt: new Date(),
    });
    await db
      .update(issues)
      .set({
        checkoutRunId: previousHolderRunId,
        executionRunId: previousHolderRunId,
        executionAgentNameKey: PREVIOUS_HOLDER_NAME_KEY,
        executionLockedAt: new Date(Date.now() - 60_000),
      })
      .where(eq(issues.id, issueId));

    await svc.assertCheckoutOwner(issueId, assigneeAgentId, actorRunId);

    const lock = await readLock(issueId);
    expect(lock?.executionRunId).toBe(actorRunId);
    // Normalized the same way `runningCheckoutExecutionPatch` normalizes it:
    // trimmed and lower-cased, not slugged.
    expect(lock?.executionAgentNameKey).toBe("security engineer");
  });
});
