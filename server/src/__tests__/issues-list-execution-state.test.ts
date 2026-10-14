import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// BLO-44407: the list projection served literal `null` for `executionPolicy` and
// `executionState`, so a row pinned to a reviewing agent read as having no wake path on
// every list surface while the single-issue read showed the live review stage.
describeEmbeddedPostgres("issue list projection of execution state (BLO-44407)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-exec-state-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("agrees with the single-issue read on the pending stage and pinned participant", async () => {
    const companyId = randomUUID();
    const reviewerId = randomUUID();
    const stageId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "List Exec State",
      issuePrefix: "LES",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: reviewerId, companyId, name: "Reviewer", role: "engineer" });
    const participant = { type: "agent", agentId: reviewerId, userId: null };
    const [pending] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Pending review",
        status: "in_review",
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), ...participant }] }],
        },
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: participant,
          returnAssignee: null,
          reviewRequest: { instructions: "x".repeat(4096) },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .returning();
    const [bare] = await db.insert(issues).values({ companyId, title: "No policy", status: "todo" }).returning();

    const svc = issueService(db);
    const single = await svc.getById(pending!.id);
    const listed = (await svc.list(companyId)).find((row) => row.id === pending!.id)!;

    expect(single?.executionState?.status).toBe("pending");
    expect(listed.executionState?.status).toBe(single?.executionState?.status);
    expect(listed.executionState?.currentStageType).toBe("review");
    expect(listed.executionState?.currentParticipant).toEqual(single?.executionState?.currentParticipant);
    // Unbounded and whole-replace on write, so absent here rather than trimmed or forged null.
    expect(single?.executionPolicy).not.toBeNull();
    expect(listed).not.toHaveProperty("executionPolicy");

    // Bounded: the multi-KB review instructions are ABSENT from the list row, not null.
    expect(listed.executionState).not.toHaveProperty("reviewRequest");

    // A row with no state is a measured null, not a forged one.
    const listedBare = (await svc.list(companyId)).find((row) => row.id === bare!.id)!;
    expect(listedBare.executionState).toBeNull();
  });
});
