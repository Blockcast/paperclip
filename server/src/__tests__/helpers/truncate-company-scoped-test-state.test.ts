import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, companySkills, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import { truncateCompanyScopedTestState } from "./truncate-company-scoped-test-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping truncateCompanyScopedTestState tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Regression cover for BLO-22231.
 *
 * The flake these tests describe is a race, but its *failure* is a
 * deterministic function of database state: cleanup breaks precisely when a row
 * referencing `heartbeat_runs` exists at the moment `heartbeat_runs` is deleted.
 * So rather than trying to win a race on a loaded host — which the earlier
 * attempt on this issue found is not a controllable lever — these tests
 * reconstruct that state directly, and additionally run one genuinely
 * concurrent case.
 */
describeEmbeddedPostgres("truncateCompanyScopedTestState", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-truncate-company-scoped-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await truncateCompanyScopedTestState(db);
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Straggler Co",
      issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Straggler Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return { companyId, agentId, runId };
  }

  /** The straggler: a best-effort audit write that lands after its request flushed. */
  async function insertStragglerActivityRow(companyId: string, agentId: string, runId: string) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "issue_write_denied",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      runId,
    });
  }

  it("documents the failure mode: an ordered delete list breaks when a straggler lands mid-cleanup", async () => {
    const { companyId, agentId, runId } = await seedRun();

    // Exactly the state the race produces: the cleanup already passed its
    // `delete(activityLog)` step, and only then did the trailing write land.
    await db.delete(activityLog);
    await insertStragglerActivityRow(companyId, agentId, runId);

    const failure = await db
      .delete(heartbeatRuns)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(failure, "expected the parent delete to be refused").not.toBeNull();
    // Postgres surfaces `code`/`constraint_name` on the wrapped cause, not on
    // the drizzle error's message.
    const cause = (failure as { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code).toBe("23503");
    expect(cause?.constraint_name).toBe("activity_log_run_id_heartbeat_runs_id_fk");
  });

  it("succeeds against that same straggler state", async () => {
    const { companyId, agentId, runId } = await seedRun();
    await db.delete(activityLog);
    await insertStragglerActivityRow(companyId, agentId, runId);

    // The assertion is simply that this does not throw where the ordered
    // delete list above does.
    await truncateCompanyScopedTestState(db);

    expect(await db.select().from(activityLog)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  it("cannot be made to fail by writes racing it concurrently", async () => {
    const { companyId, agentId, runId } = await seedRun();

    // Fire stragglers without awaiting them, then immediately clean up. Each
    // insert either commits before the TRUNCATE takes its locks (and is
    // truncated) or blocks and then fails its own FK check — the same swallowed
    // best-effort failure the production writers already tolerate. Neither
    // outcome may break cleanup.
    const stragglers = Array.from({ length: 12 }, () =>
      insertStragglerActivityRow(companyId, agentId, runId).catch(() => "rejected-harmlessly"),
    );

    await truncateCompanyScopedTestState(db);
    await Promise.all(stragglers);

    // A straggler that lost the race may have left nothing; one that won was
    // truncated. Either way the table is empty and cleanup did not throw.
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
  });

  /**
   * BLO-35765: the same failure mode with a different straggler.
   *
   * `company-skills-service.test.ts` had no supertest in it at all -- there the
   * surviving writer is a test that blew its 60s budget. Vitest fails a
   * timed-out test but does not cancel it, so its `forkSkill` calls keep
   * inserting into `company_skills` while `afterEach` runs.
   * `company_skills.company_id` has no `onDelete` action, so a straggler landing
   * between `delete(companySkills)` and `delete(companies)` breaks the parent
   * delete and buries the timeout under a second annotation.
   *
   * What these tests do NOT do: guard that file's `afterEach`. Reverting it to
   * the ordered delete list fails none of them, because a race inside another
   * suite's hook cannot be forced deterministically from here. What they pin
   * instead is the helper: the first test documents the wedged state the race
   * leaves behind, on which the ordered list's remaining `delete(companies)`
   * step fails; the second proves the helper, called with the exact options
   * that `afterEach` passes, clears that same state; the third is a smoke test
   * only.
   */
  async function seedSkillCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Skill Straggler Co",
      issuePrefix: `K${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
    });
    return companyId;
  }

  /** The straggler: a fork insert from a timed-out test that is still running. */
  async function insertStragglerSkill(companyId: string) {
    const slug = `fork-${randomUUID()}`;
    await db.insert(companySkills).values({
      companyId,
      key: `company/${companyId}/${slug}`,
      slug,
      name: "Straggler Skill",
      markdown: "# Straggler Skill\n",
      sourceType: "local_path",
    });
  }

  it("documents the failure mode: a straggler company_skills insert breaks the parent delete", async () => {
    const companyId = await seedSkillCompany();

    // The state the race produces: cleanup already passed its
    // `delete(companySkills)` step, and only then did the fork insert land.
    await db.delete(companySkills);
    await insertStragglerSkill(companyId);

    const failure = await db
      .delete(companies)
      .then(() => null)
      .catch((err: unknown) => err);

    expect(failure, "expected the parent delete to be refused").not.toBeNull();
    const cause = (failure as { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code).toBe("23503");
    expect(cause?.constraint_name).toBe("company_skills_company_id_companies_id_fk");
  });

  it("clears that same straggler state with the options company-skills-service.test.ts passes", async () => {
    const companyId = await seedSkillCompany();
    await db.delete(companySkills);
    await insertStragglerSkill(companyId);
    // `authUsers` is not reachable from the companies cascade, which is why that
    // suite's `afterEach` must name its physical table, "user", explicitly.
    const now = new Date();
    await db.insert(authUsers).values({
      id: randomUUID(),
      name: "Straggler User",
      email: `straggler-${randomUUID()}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    await truncateCompanyScopedTestState(db, { extraTruncateTables: ["user"] });

    expect(await db.select().from(companySkills)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
    expect(await db.select().from(authUsers)).toHaveLength(0);
  });

  it("smoke: survives company_skills writes racing it concurrently", async () => {
    const companyId = await seedSkillCompany();

    // Not regression cover. There is no forcing mechanism, so these assertions
    // hold under every interleaving: a straggler that commits first is
    // truncated, one that blocks is rejected and swallowed. It fails only if the
    // helper itself throws under concurrent writers, and it cannot prove the
    // race window was ever entered.

    const stragglers = Array.from({ length: 12 }, () =>
      insertStragglerSkill(companyId).catch(() => "rejected-harmlessly"),
    );

    await truncateCompanyScopedTestState(db);
    await Promise.all(stragglers);

    expect(await db.select().from(companySkills)).toHaveLength(0);
    expect(await db.select().from(companies)).toHaveLength(0);
  });
});
