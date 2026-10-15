import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  renderMetrics,
  WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC,
  WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC,
} from "../services/metrics.js";
import {
  refreshWorkspaceReuseRefusalMetrics,
  WORKSPACE_REUSE_REFUSAL_WINDOW_MS,
} from "../services/workspace-reuse-refusal-metrics.js";
import {
  formatGitProbeRefusal,
  formatOriginMismatchRefusal,
} from "../services/workspace-reuse-refusal-class.js";

/**
 * PEN-3633 item 3. The aggregation claim is that N run-level refusals sharing
 * one project workspace collapse into ONE series naming that workspace. These
 * tests assert that collapse against a real database, because the join
 * (heartbeat_runs.context_issue_id, a generated TEXT column, onto issues.id, a
 * UUID) is exactly the kind of thing that typechecks and then returns nothing.
 */

/** Value of one labelled series in the exposition body, or null when absent. */
function seriesValue(body: string, metric: string, labels: Record<string, string>): number | null {
  const labelPart = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(",");
  const match = body.match(
    new RegExp(`^${metric}\\{${labelPart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\} (\\S+)$`, "m"),
  );
  return match ? Number(match[1]) : null;
}

function unlabelledGauge(body: string, metric: string): number | null {
  const match = body.match(new RegExp(`^${metric} (\\S+)$`, "m"));
  return match ? Number(match[1]) : null;
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("refreshWorkspaceReuseRefusalMetrics (PEN-3633)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workspace-reuse-refusal-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE heartbeat_runs, issues, project_workspaces, projects, agents, companies CASCADE`,
    );
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const NOW = new Date("2026-10-05T13:10:00.000Z");

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Refusal Co",
      issuePrefix: "RFC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Refusing Agent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Refusal Project" });
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "shared checkout",
    });
    return { companyId, agentId, projectWorkspaceId };
  }

  let issueCounter = 0;

  async function seedFailedRun(input: {
    companyId: string;
    agentId: string;
    projectWorkspaceId: string | null;
    error: string | null;
    finishedAt?: Date;
    status?: string;
  }) {
    const issueId = randomUUID();
    issueCounter += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: `refusing issue ${issueCounter}`,
      issueNumber: issueCounter,
      identifier: `RFC-${issueCounter}`,
      projectWorkspaceId: input.projectWorkspaceId,
    });
    await db.insert(heartbeatRuns).values({
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "failed",
      error: input.error,
      errorCode: "setup_failed",
      finishedAt: input.finishedAt ?? new Date(NOW.getTime() - 60_000),
      contextSnapshot: { issueId },
    });
  }

  it("collapses many run-level refusals sharing one checkout into ONE project-scoped series", async () => {
    // The measured shape: 565 of 570 issues in the affected project share one
    // project_workspace_id, so a broken checkout produced many *separate* run
    // failures. The whole value of this metric is that they arrive as one row.
    const { companyId, agentId, projectWorkspaceId } = await seedCompany();
    const refusal = formatGitProbeRefusal({
      state: "not_a_checkout",
      cwd: "/paperclip/instances/default/workspaces/shared",
      probeReason: "no git directory",
    });
    for (let i = 0; i < 7; i += 1) {
      await seedFailedRun({ companyId, agentId, projectWorkspaceId, error: refusal });
    }

    await refreshWorkspaceReuseRefusalMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(
      seriesValue(body, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, {
        project_workspace_id: projectWorkspaceId,
        failure_class: "not_a_checkout",
      }),
    ).toBe(7);
    expect(unlabelledGauge(body, WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC)).toBe(1);
  });

  it("separates the two measured episodes, which error_code alone cannot", async () => {
    // Both book as `setup_failed`. If they merged into one bucket, this metric
    // would reproduce the very conflation the row was filed to undo.
    const { companyId, agentId, projectWorkspaceId } = await seedCompany();
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      error: formatOriginMismatchRefusal({
        cwd: "/w",
        actualUrl: "git@github.com:Blockcast/paperclip.git",
        expectedRepoUrl: "https://github.com/Blockcast/penstock-llm-proxy-core",
      }),
    });
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      error: formatGitProbeRefusal({ state: "indeterminate", cwd: "/w", probeReason: "dubious ownership" }),
    });

    await refreshWorkspaceReuseRefusalMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(
      seriesValue(body, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, {
        project_workspace_id: projectWorkspaceId,
        failure_class: "origin_mismatch",
      }),
    ).toBe(1);
    expect(
      seriesValue(body, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, {
        project_workspace_id: projectWorkspaceId,
        failure_class: "probe_indeterminate",
      }),
    ).toBe(1);
  });

  it("ignores failures outside the class and runs outside the window", async () => {
    // Negative control for both axes. Without the first, every unrelated
    // setup_failed in the fleet would page this alert; without the second, a
    // long-resolved episode would hold it open forever.
    const { companyId, agentId, projectWorkspaceId } = await seedCompany();
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      error: "Error: connect ECONNREFUSED 10.0.0.1:5432",
    });
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      error: formatGitProbeRefusal({ state: "not_a_checkout", cwd: "/w", probeReason: "gone" }),
      finishedAt: new Date(NOW.getTime() - WORKSPACE_REUSE_REFUSAL_WINDOW_MS - 60_000),
    });
    // A refusal that did not FAIL the run is not an episode either.
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      status: "succeeded",
      error: formatGitProbeRefusal({ state: "not_a_checkout", cwd: "/w", probeReason: "gone" }),
    });

    await refreshWorkspaceReuseRefusalMetrics(db, NOW);
    const { body } = await renderMetrics();

    expect(body).not.toContain(`${WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC}{`);
    expect(unlabelledGauge(body, WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC)).toBe(1);
  });

  it("drops a drained series on the next sweep rather than holding a stale count", async () => {
    // Reset-then-set. A retained count would hold the alert firing after the
    // checkout was repaired, which is how an operator learns to ignore it.
    const { companyId, agentId, projectWorkspaceId } = await seedCompany();
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      error: formatGitProbeRefusal({ state: "not_a_checkout", cwd: "/w", probeReason: "gone" }),
    });
    await refreshWorkspaceReuseRefusalMetrics(db, NOW);
    expect((await renderMetrics()).body).toContain(`${WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC}{`);

    await db.execute(sql`TRUNCATE TABLE heartbeat_runs CASCADE`);
    await refreshWorkspaceReuseRefusalMetrics(db, NOW);

    expect((await renderMetrics()).body).not.toContain(`${WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC}{`);
  });

  it("marks the snapshot stale instead of zeroing it when the sweep throws", async () => {
    // Zeroing would read as "this project stopped refusing" -- the one
    // conclusion a failed sweep cannot support.
    const { companyId, agentId, projectWorkspaceId } = await seedCompany();
    await seedFailedRun({
      companyId,
      agentId,
      projectWorkspaceId,
      error: formatGitProbeRefusal({ state: "not_a_checkout", cwd: "/w", probeReason: "gone" }),
    });
    await refreshWorkspaceReuseRefusalMetrics(db, NOW);

    const brokenDb = {
      select: () => {
        throw new Error("sweep exploded");
      },
    } as unknown as ReturnType<typeof createDb>;
    await expect(refreshWorkspaceReuseRefusalMetrics(brokenDb, NOW)).rejects.toThrow("sweep exploded");

    const { body } = await renderMetrics();
    expect(unlabelledGauge(body, WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC)).toBe(0);
    expect(
      seriesValue(body, WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC, {
        project_workspace_id: projectWorkspaceId,
        failure_class: "not_a_checkout",
      }),
    ).toBe(1);
  });
});
