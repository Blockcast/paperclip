import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environments,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.ts";
import {
  evaluateIssueRepoBinding,
  formatIssueRepoBindingComment,
} from "../services/issue-repo-binding-guard.ts";

/**
 * BLO-20341 — a delegated sub-issue inherits its repo binding from its parent
 * (where the bug was found), not from where the code lives. These tests pin
 * the detect-only guard that flags that, and — just as importantly — pin its
 * silence on the shapes that must never fire.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

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
    `Skipping embedded Postgres repo-binding-guard tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("BLO-20341 issue repo binding guard", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const PAPERCLIP_REPO = "https://github.com/Blockcast/paperclip.git";
  const TRAFFICCONTROL_REPO = "https://github.com/Blockcast/trafficcontrol.git";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repo-binding-");
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

  /**
   * Seeds a company with two projects: one bound to trafficcontrol (where the
   * bug gets discovered) and one bound to paperclip (where the control-plane
   * code actually lives) — the exact BLO-17980 shape.
   */
  async function seedTwoProjectCompany() {
    const companyId = randomUUID();
    const productProjectId = randomUUID();
    const controlPlaneProjectId = randomUUID();
    const productWorkspaceId = randomUUID();
    const controlPlaneWorkspaceId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Blockcast",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    await db.insert(projects).values([
      { id: productProjectId, companyId, name: "Tenant + Auth", status: "in_progress" },
      { id: controlPlaneProjectId, companyId, name: "Paperclip", status: "in_progress" },
    ]);

    await db.insert(projectWorkspaces).values([
      {
        id: productWorkspaceId,
        companyId,
        projectId: productProjectId,
        name: "trafficcontrol",
        isPrimary: true,
        repoUrl: TRAFFICCONTROL_REPO,
      },
      {
        id: controlPlaneWorkspaceId,
        companyId,
        projectId: controlPlaneProjectId,
        name: "paperclip",
        isPrimary: true,
        repoUrl: PAPERCLIP_REPO,
      },
    ]);

    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      projectId: productProjectId,
      projectWorkspaceId: productWorkspaceId,
      title: "Stop exposing inline credentials through read-only agent Pod specs",
      status: "in_progress",
      priority: "critical",
    });

    return {
      companyId,
      productProjectId,
      controlPlaneProjectId,
      productWorkspaceId,
      controlPlaneWorkspaceId,
      parentIssueId,
    };
  }

  async function guardComments(issueId: string) {
    return db
      .select({ body: issueComments.body, authorType: issueComments.authorType })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.filter((row) => row.body.includes("Repo binding check")));
  }

  it("flags a child whose description names repo B under a parent bound to repo A", async () => {
    const seed = await seedTwoProjectCompany();

    const child = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Fix agent-job Pod credential injection",
      description:
        "This is a Paperclip control-plane fix, not Blockcast CDN product code. " +
        "The templating lives in https://github.com/Blockcast/paperclip and must change there.",
    });

    const comments = await guardComments(child.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].authorType).toBe("system");
    // The AC requires the signal to name BOTH sides.
    expect(comments[0].body).toContain("Blockcast/trafficcontrol");
    expect(comments[0].body).toContain("Blockcast/paperclip");
    // ...and to point at where that repo actually is, without re-homing.
    expect(comments[0].body).toContain("Paperclip");
    expect(child.projectId).toBe(seed.productProjectId);
    expect(child.projectWorkspaceId).toBe(seed.productWorkspaceId);
  });

  it("stays silent when the child names the repo it is already bound to", async () => {
    const seed = await seedTwoProjectCompany();

    const child = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Tenant-aware UI fix",
      description: "Change lives in https://github.com/Blockcast/trafficcontrol under the UI tree.",
    });

    expect(await guardComments(child.id)).toHaveLength(0);
  });

  it("stays silent when the child names no repository at all", async () => {
    const seed = await seedTwoProjectCompany();

    const child = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Tighten the tenant claim check",
      description: "Update the claim validation in `server/src` and add a test in `packages/db`.",
    });

    expect(await guardComments(child.id)).toHaveLength(0);
  });

  it("stays silent for a root issue even when it names another repo", async () => {
    const seed = await seedTwoProjectCompany();

    const root = await svc.create(seed.companyId, {
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Root issue citing another repo for context",
      description: "Follow the pattern in https://github.com/Blockcast/paperclip when doing this.",
    });

    expect(await guardComments(root.id)).toHaveLength(0);
  });

  it("reports a repo that no workspace in this company binds", async () => {
    const seed = await seedTwoProjectCompany();

    const child = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Fix the vendored adapter",
      description:
        "The code lives in `kkroo/paperclip-adapter-claude-k8s`, vendored at Dockerfile:399-405 — " +
        "outside every project workspace we bind.",
    });

    const comments = await guardComments(child.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("kkroo/paperclip-adapter-claude-k8s");
    expect(comments[0].body).toContain("no workspace in this company binds this repo");
  });

  it("prefers the pinned execution workspace over the project binding", async () => {
    const seed = await seedTwoProjectCompany();
    const executionWorkspaceId = randomUUID();

    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId: seed.companyId,
      projectId: seed.controlPlaneProjectId,
      projectWorkspaceId: seed.controlPlaneWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "paperclip-shared",
      status: "active",
      providerType: "local_fs",
      repoUrl: PAPERCLIP_REPO,
    });

    // Bound (via the pinned execution workspace) to paperclip and naming
    // paperclip: the project row still points at trafficcontrol, so a guard
    // that ignored the execution workspace would false-positive here.
    const child = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      executionWorkspaceId,
      title: "Control-plane fix pinned to the paperclip worktree",
      description: "Change lands in https://github.com/Blockcast/paperclip.",
    });

    expect(await guardComments(child.id)).toHaveLength(0);
  });

  it("does not post twice when a create is deduplicated into an existing issue", async () => {
    const seed = await seedTwoProjectCompany();
    const description = "Fix lives in https://github.com/Blockcast/paperclip instead.";

    const first = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Idempotent child",
      description,
      idempotencyKey: "blo-20341-dedup-probe",
    });
    const second = await svc.create(seed.companyId, {
      parentId: seed.parentIssueId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      title: "Idempotent child",
      description,
      idempotencyKey: "blo-20341-dedup-probe",
    });

    expect(second.id).toBe(first.id);
    expect(await guardComments(first.id)).toHaveLength(1);
  });

  it("never fails or rolls back an issue create when the guard cannot run", async () => {
    const seed = await seedTwoProjectCompany();
    // Drop the table the guard reads so its query throws. The create must
    // still succeed — an advisory comment is not allowed to break creation.
    await db.execute(sql.raw(`ALTER TABLE "project_workspaces" RENAME TO "project_workspaces_hidden"`));
    try {
      const child = await svc.create(seed.companyId, {
        parentId: seed.parentIssueId,
        projectId: seed.productProjectId,
        title: "Create survives a broken guard",
        description: "Fix lives in https://github.com/Blockcast/paperclip.",
      });
      expect(child.id).toBeTruthy();
      expect(await guardComments(child.id)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`ALTER TABLE "project_workspaces_hidden" RENAME TO "project_workspaces"`));
    }
  });

  it("evaluateIssueRepoBinding returns null for a root issue and for empty prose", async () => {
    const seed = await seedTwoProjectCompany();
    const base = {
      db,
      companyId: seed.companyId,
      projectId: seed.productProjectId,
      projectWorkspaceId: seed.productWorkspaceId,
      executionWorkspaceId: null,
    };

    expect(
      await evaluateIssueRepoBinding({
        ...base,
        parentId: null,
        description: "https://github.com/Blockcast/paperclip",
      }),
    ).toBeNull();
    expect(
      await evaluateIssueRepoBinding({ ...base, parentId: seed.parentIssueId, description: "" }),
    ).toBeNull();
    expect(
      await evaluateIssueRepoBinding({ ...base, parentId: seed.parentIssueId, description: null }),
    ).toBeNull();
  });

  it("flags an issue that names a repo while bound to no workspace at all", async () => {
    const seed = await seedTwoProjectCompany();

    const signal = await evaluateIssueRepoBinding({
      db,
      companyId: seed.companyId,
      parentId: seed.parentIssueId,
      projectId: null,
      projectWorkspaceId: null,
      executionWorkspaceId: null,
      description: "Fix lives in https://github.com/Blockcast/paperclip.",
    });

    expect(signal?.kind).toBe("unbound_issue");
    const body = formatIssueRepoBindingComment(signal!);
    expect(body).toContain("no workspace at all");
    expect(body).toContain("Blockcast/paperclip");
  });
});
