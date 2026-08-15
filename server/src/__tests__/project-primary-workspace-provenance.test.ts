import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, projects as projectsTable, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { projectService, promoteFirstSurvivingWorkspace } from "../services/projects.js";
import { PROJECT_PRIMARY_WORKSPACE_FALLBACK_METRIC, __resetMetricsForTest, renderMetrics } from "../services/metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres primary-workspace provenance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-26184: the CTO affirmed the earliest-created fallback as correct
// resolution behaviour (a multi-workspace project with no explicit primary
// must not refuse to resolve) and asked only that the guess stop being
// silent. These cases are the acceptance-criteria verifying signal:
// (a) 0-workspace resolves null/"none", (b) multi-workspace/no-primary
// resolves earliest-created AND reports "inferred" plus the fallback
// counter, (c) an explicit primary reports "explicit", (d) add/remove
// sequences preserve exactly one isPrimary=true, and (e) a project that has
// already drifted (the CDN+ Supply Side Rewards shape) self-heals the next
// time any workspace write touches it.
describeEmbeddedPostgres("project primary-workspace provenance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let prefixCounter = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-primary-workspace-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projectsTable);
    await db.delete(companies);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    prefixCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: "Workspace Co", issuePrefix: `WSP${prefixCounter}` })
      .returning();
    return company.id;
  }

  it("resolves primaryWorkspace null and source 'none' for a 0-workspace project", async () => {
    const companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Empty" });
    expect(created.workspaces).toHaveLength(0);
    expect(created.primaryWorkspace).toBeNull();
    expect(created.primaryWorkspaceSource).toBe("none");

    const fetched = await projects.getById(created.id);
    expect(fetched?.primaryWorkspace).toBeNull();
    expect(fetched?.primaryWorkspaceSource).toBe("none");
  });

  it("reports 'explicit' when a workspace is flagged isPrimary", async () => {
    const companyId = await seedCompany();
    const projects = projectService(db);

    const created = await projects.create(companyId, { name: "Single Workspace" });
    const workspace = await projects.createWorkspace(created.id, {
      repoUrl: "https://github.com/example/repo.git",
    });
    expect(workspace?.isPrimary).toBe(true);

    const fetched = await projects.getById(created.id);
    expect(fetched?.primaryWorkspaceSource).toBe("explicit");
    expect(fetched?.primaryWorkspace?.id).toBe(workspace!.id);
  });

  it(
    "resolves earliest-created and reports 'inferred' plus the fallback counter for a drifted " +
      "multi-workspace project with no explicit primary (the CDN+ Supply Side Rewards shape)",
    async () => {
      const companyId = await seedCompany();
      const projects = projectService(db);

      const created = await projects.create(companyId, { name: "Drifted" });
      const first = await projects.createWorkspace(created.id, { repoUrl: "https://github.com/example/first.git" });
      const second = await projects.createWorkspace(created.id, {
        repoUrl: "https://github.com/example/second.git",
        isPrimary: true,
      });
      expect(first?.isPrimary).toBe(true);
      expect(second?.isPrimary).toBe(true);

      // Simulate the drifted state directly (BLO-23599's CDN+ Supply Side
      // Rewards had 3 workspaces / 0 primaries). Every write path this suite
      // otherwise exercises self-heals to exactly one primary (see below),
      // so reaching this state requires an out-of-band write — which is
      // exactly what makes the *read* path worth guarding.
      await db
        .update(projectWorkspaces)
        .set({ isPrimary: false })
        .where(eq(projectWorkspaces.projectId, created.id));

      const fetched = await projects.getById(created.id);
      expect(fetched?.workspaces).toHaveLength(2);
      expect(fetched?.workspaces.every((w) => !w.isPrimary)).toBe(true);
      expect(fetched?.primaryWorkspaceSource).toBe("inferred");
      // Earliest-created (`first`) wins the fallback, per the affirmed
      // resolution behaviour.
      expect(fetched?.primaryWorkspace?.id).toBe(first!.id);

      const { body } = await renderMetrics();
      expect(body).toContain(`${PROJECT_PRIMARY_WORKSPACE_FALLBACK_METRIC} 1`);
    },
  );

  it("never throws for 0 or >=1 workspaces (fail-open contract)", async () => {
    const companyId = await seedCompany();
    const projects = projectService(db);

    const empty = await projects.create(companyId, { name: "Fail Open Empty" });
    await expect(projects.getById(empty.id)).resolves.not.toThrow();

    const populated = await projects.create(companyId, { name: "Fail Open Populated" });
    await projects.createWorkspace(populated.id, { repoUrl: "https://github.com/example/a.git" });
    await projects.createWorkspace(populated.id, { repoUrl: "https://github.com/example/b.git" });
    await expect(projects.getById(populated.id)).resolves.not.toThrow();
  });

  it("preserves exactly one isPrimary=true through add and remove sequences", async () => {
    const companyId = await seedCompany();
    const projects = projectService(db);
    const created = await projects.create(companyId, { name: "Sequenced" });

    async function countPrimaries(): Promise<number> {
      const fetched = await projects.getById(created.id);
      return fetched!.workspaces.filter((w) => w.isPrimary).length;
    }

    const a = await projects.createWorkspace(created.id, { repoUrl: "https://github.com/example/a.git" });
    expect(await countPrimaries()).toBe(1);
    expect(a?.isPrimary).toBe(true);

    const b = await projects.createWorkspace(created.id, { repoUrl: "https://github.com/example/b.git" });
    expect(await countPrimaries()).toBe(1);
    expect(b?.isPrimary).toBe(false);

    const c = await projects.createWorkspace(created.id, {
      repoUrl: "https://github.com/example/c.git",
      isPrimary: true,
    });
    expect(await countPrimaries()).toBe(1);
    expect(c?.isPrimary).toBe(true);

    // Removing the current primary (c) must re-promote a survivor, not leave
    // the project with zero primaries.
    await projects.removeWorkspace(created.id, c!.id);
    expect(await countPrimaries()).toBe(1);

    // Removing a non-primary workspace must not disturb the primary.
    const beforeRemoveB = await projects.getById(created.id);
    const primaryBefore = beforeRemoveB!.primaryWorkspace!.id;
    await projects.removeWorkspace(created.id, b!.id);
    const afterRemoveB = await projects.getById(created.id);
    expect(afterRemoveB!.primaryWorkspace!.id).toBe(primaryBefore);
    expect(await countPrimaries()).toBe(1);

    // Down to the last workspace — still exactly one primary.
    const finalState = await projects.getById(created.id);
    expect(finalState!.workspaces).toHaveLength(1);
    expect(finalState!.primaryWorkspaceSource).toBe("explicit");
  });

  it(
    "self-heals a drifted 0-primary project the next time any workspace write touches it " +
      "(updateWorkspace's post-write invariant check, ensureSinglePrimaryWorkspace)",
    async () => {
      const companyId = await seedCompany();
      const projects = projectService(db);
      const created = await projects.create(companyId, { name: "Heals On Write" });

      const a = await projects.createWorkspace(created.id, { repoUrl: "https://github.com/example/a.git" });
      const b = await projects.createWorkspace(created.id, { repoUrl: "https://github.com/example/b.git" });
      await projects.createWorkspace(created.id, { repoUrl: "https://github.com/example/c.git" });
      expect(a?.isPrimary).toBe(true);

      // Force the drifted state directly, same as the read-path test above.
      await db
        .update(projectWorkspaces)
        .set({ isPrimary: false })
        .where(eq(projectWorkspaces.projectId, created.id));
      const drifted = await projects.getById(created.id);
      expect(drifted?.primaryWorkspaceSource).toBe("inferred");

      // An update that doesn't even touch isPrimary still runs the
      // post-write invariant check and re-promotes a survivor.
      await projects.updateWorkspace(created.id, b!.id, { name: "renamed-b" });

      const healed = await projects.getById(created.id);
      expect(healed?.primaryWorkspaceSource).toBe("explicit");
      expect(healed?.workspaces.filter((w) => w.isPrimary)).toHaveLength(1);
    },
  );
});

// BLO-26184 review follow-up: the first cut of the concurrent-removal retry
// capped itself at 5 attempts, which is a number real candidates can reach.
// A project with >5 workspaces whose promotions kept losing the race exited the
// loop with candidates still untried and every row already demoted — silently,
// because the caller only warned on the exhausted branch. These cases pin the
// walk's contract directly; they need no database, so they run on every host
// rather than only where embedded Postgres is available.
describe("promoteFirstSurvivingWorkspace", () => {
  it("keeps walking past the old 5-attempt cap when the initial target and five more are removed", async () => {
    // The SELECT still sees all seven rows; each of the first six is deleted by
    // a racing transaction in the window before its own promote UPDATE lands.
    const ids = ["w1", "w2", "w3", "w4", "w5", "w6", "w7"];
    const doomed = new Set(["w1", "w2", "w3", "w4", "w5", "w6"]);
    const attempted: string[] = [];

    const outcome = await promoteFirstSurvivingWorkspace({
      initialCandidateId: "w1",
      tryPromote: async (id) => {
        attempted.push(id);
        return !doomed.has(id);
      },
      listCandidateIds: async () => ids,
    });

    expect(outcome.result).toBe("promoted");
    expect(outcome.promotedId).toBe("w7");
    // Seven attempts: the old MAX_ATTEMPTS = 5 gave up two candidates short.
    expect(attempted).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7"]);
  });

  it("never retries a candidate it has already tried", async () => {
    const attempted: string[] = [];

    const outcome = await promoteFirstSurvivingWorkspace({
      initialCandidateId: "a",
      tryPromote: async (id) => {
        attempted.push(id);
        return false;
      },
      // A stable list: without the tried-set guard this would loop on "a".
      listCandidateIds: async () => ["a", "b"],
    });

    expect(attempted).toEqual(["a", "b"]);
    expect(outcome.result).toBe("candidates_exhausted");
    expect(outcome.promotedId).toBeNull();
  });

  it("reports candidates_exhausted when every workspace was concurrently removed", async () => {
    const outcome = await promoteFirstSurvivingWorkspace({
      initialCandidateId: "gone",
      tryPromote: async () => false,
      listCandidateIds: async () => [],
    });

    expect(outcome.result).toBe("candidates_exhausted");
    expect(outcome.promotedId).toBeNull();
    expect(outcome.triedIds).toEqual(["gone"]);
  });

  it("reports attempt_cap_reached — not exhaustion — when it gives up with candidates left", async () => {
    // An endless supply of fresh candidates that never promote: the only way
    // out is the safety valve. The caller must be able to distinguish this
    // from exhaustion, because here the project still has promotable rows.
    let issued = 0;
    const outcome = await promoteFirstSurvivingWorkspace({
      initialCandidateId: "c0",
      tryPromote: async () => false,
      listCandidateIds: async () => {
        issued += 1;
        return Array.from({ length: issued + 1 }, (_, i) => `c${i}`);
      },
      maxAttempts: 3,
    });

    expect(outcome.result).toBe("attempt_cap_reached");
    expect(outcome.promotedId).toBeNull();
    expect(outcome.triedIds).toHaveLength(3);
  });
});
