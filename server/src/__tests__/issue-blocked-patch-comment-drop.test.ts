import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueLabels,
  issueRelations,
  issues,
  labels,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comment-drop tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// PEN-3255, third Done-when. A `PATCH /issues/:id` may carry a `comment`
// alongside the field changes, but every comment write in the route happens
// *after* `svc.update` returns. So when a guard refuses the update the comment
// is discarded with no row, no log line and nothing in the response body — the
// operator who bundled "move this to in_progress" with the note explaining why
// keeps only a 422 about blockers and silently loses the note.
//
// The fix surfaces the drop rather than persisting it: the comment almost
// always narrates a transition that did not happen, so writing it would record
// a false narrative against the row. These tests pin BOTH halves of that — the
// refusal must announce the drop, and it must still genuinely not write the
// comment. A fix that quietly started persisting it would pass a
// response-only assertion.
describeEmbeddedPostgres("PATCH refused by the blocker guard does not silently drop its comment", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-drop-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(issueRelations);
    // Before `heartbeat_runs`: an accepted PATCH writes an activity_log row
    // that FK-references the run, so tearing the run down first fails on
    // `activity_log_run_id_heartbeat_runs_id_fk`.
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    // The done-gate test below turns on an instance-wide experimental flag.
    // Reset it unconditionally so this file cannot leak the flag into whatever
    // runs next, and so the reset does not depend on that test passing.
    await db
      .insert(instanceSettings)
      .values({ singletonKey: "default", general: {}, experimental: {} })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { experimental: {} },
      });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  // The agent is the assignee so the coordination gate passes and the request
  // reaches the dependency guard — an unassigned actor is refused earlier with
  // a 403 and would never exercise this path.
  async function seedAssignedIssue({ withBlocker }: { withBlocker: boolean }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const blockerIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Dependent",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    if (withBlocker) {
      // Left open on purpose: an unresolved blocker is what the guard refuses
      // on. The edge is (issueId = blocker, relatedIssueId = dependent) per
      // `listIssueDependencyReadinessMap`, which reads the blocker off
      // `issueRelations.issueId`.
      await db.insert(issues).values({
        id: blockerIssueId,
        companyId,
        title: "Blocker still open",
        status: "todo",
        priority: "high",
      });
      await db.insert(issueRelations).values({
        id: randomUUID(),
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
      });
    }

    return { companyId, agentId, runId, issueId, blockerIssueId };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  /**
   * An issue the evidence gate will refuse on a move to `in_review`: labelled
   * `frontend`, so the registry requires screenshots, and carrying Done-when
   * bullets with nothing satisfying them. Seeded `in_progress` so the PATCH is
   * a real transition into `in_review` — `isInReviewTransition` is what arms
   * the gate.
   *
   * The scheduled monitor is load-bearing, not decoration.
   * `assertAgentInReviewReviewPath` refuses an agent-authored move to
   * `in_review` that leaves nobody owning the next action, and it runs *before*
   * the evidence gate — so without a review path the request never reaches the
   * refusal under test. A future `monitorNextCheckAt` on the row is the one
   * review path that keeps the PATCH body at exactly `{status, comment}`; the
   * others (`assigneeUserId`, `executionState.currentParticipant`,
   * `executionPolicy`) would add a third key and change which guard fires.
   * It is also the realistic shape: an agent moving to review behind a
   * scheduled check is the documented loop.
   */
  async function seedEvidenceGatedIssue() {
    const seeded = await seedAssignedIssue({ withBlocker: false });
    const labelId = randomUUID();
    await db.insert(labels).values({
      id: labelId,
      companyId: seeded.companyId,
      name: "frontend",
      color: "#000000",
    });
    await db.insert(issueLabels).values({ issueId: seeded.issueId, labelId, companyId: seeded.companyId });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        description: "## Done when\n- desktop works\n- mobile works",
        monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(eq(issues.id, seeded.issueId));
    return seeded;
  }

  async function commentRows(issueId: string) {
    return db.select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
  }

  it("announces the dropped comment in the 422, and still does not write it", async () => {
    const { companyId, agentId, runId, issueId, blockerIssueId } =
      await seedAssignedIssue({ withBlocker: true });
    const app = createApp(agentActor(companyId, agentId, runId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Starting this now — the blocker is stale, see PEN-3255." });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("Issue is blocked by unresolved blockers");

    const details = res.body.details as Record<string, unknown>;

    // The drop is stated, not merely implied by the absence of a comment.
    expect(
      details.commentPersisted,
      `the refusal must say the carried comment was not saved; got ${JSON.stringify(details)}`,
    ).toBe(false);
    expect(String(details.commentHint)).toContain("POST /api/issues/:id/comments");

    // The original refusal details must survive the enrichment. This is the
    // assertion that catches a fix which replaces `details` instead of
    // extending it — the blocker ids are what makes the 422 actionable, and
    // losing them would trade one silent loss for another.
    expect(details.unresolvedBlockerIssueIds).toEqual([blockerIssueId]);

    // And the comment genuinely is not persisted. Without this the suite would
    // pass against a "fix" that started writing the comment and reported the
    // drop anyway.
    expect(await commentRows(issueId)).toEqual([]);
  });

  // Complement: the announcement is tied to a comment actually having been
  // carried. Without this, a fix that stamps `commentPersisted: false` onto
  // every 422 would pass the test above while telling operators a comment was
  // dropped on requests that never carried one.
  it("says nothing about comments when the refused PATCH carried none", async () => {
    const { companyId, agentId, runId, issueId, blockerIssueId } =
      await seedAssignedIssue({ withBlocker: true });
    const app = createApp(agentActor(companyId, agentId, runId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const details = res.body.details as Record<string, unknown>;
    expect(details.unresolvedBlockerIssueIds).toEqual([blockerIssueId]);
    expect(details).not.toHaveProperty("commentPersisted");
    expect(details).not.toHaveProperty("commentHint");
  });

  // Positive control for the happy path: the enrichment lives in a `catch`, so
  // an accepted PATCH must still persist its comment exactly as before. A
  // regression here would be invisible to both tests above, since neither
  // exercises a successful write.
  it("still persists the comment when the PATCH is accepted", async () => {
    const { companyId, agentId, runId, issueId } = await seedAssignedIssue({ withBlocker: false });
    const app = createApp(agentActor(companyId, agentId, runId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Picking this up." });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await commentRows(issueId);
    expect(rows.map((row) => row.body)).toEqual(["Picking this up."]);
  });

  // Review follow-up (#1895): the three tests above all refuse on the *blocker*
  // guard, so none of them distinguishes "the enrichment covers any refusal
  // escaping `svc.update`" from "the enrichment is wired to the blocker guard".
  // This one refuses on a different guard entirely — the done-gate — and
  // carries a different `details` payload, so it pins the generalization and
  // the survival of details it has never seen.
  //
  // The reviewer asked for a fourth test driving the **409** arm instead. That
  // one is not writable: every non-422 refusal `svc.update` can raise on this
  // route is a `conflict(...)` from a precondition that snapshots the very row
  // the route already read (`expectedNoUnresolvedBlockers`,
  // `expectedCurrentStatus`, `expectedCurrent*RunId`,
  // `expectedCurrentExecution{State,Policy}`), so it fires only when a
  // concurrent writer moves the row mid-request. The repro suggested in review
  // — seed a blocker, PATCH `blockedByIssueIds: []` + `status` — does not reach
  // it from either side: `isCreatorOrManagerChainRecoveryPatch` admits a body
  // of *exactly* `{status, blockedByIssueIds}`, so adding `comment` makes it
  // three keys and `delegateRecoveryPatchInFlight` false, and the other two
  // `unresolvedBlockerWriteGuardInFlight` arms are each preceded by a
  // route-level `res.status(409).json()` that returns before the write. Staging
  // the real race needs two requests to interleave between a plain read and a
  // locked write, which is a flaky test, not a deterministic one. The 409
  // coverage in the route is therefore deliberate defensive breadth over a real
  // production race rather than a path this suite exercises.
  it("announces the drop on a refusal from a different guard, preserving its details", async () => {
    const { companyId, agentId, runId, issueId } = await seedAssignedIssue({ withBlocker: false });
    // Default is off, so without this the PATCH is simply accepted and nothing
    // is exercised. Upsert, not insert: migrations seed the singleton row.
    await db
      .insert(instanceSettings)
      .values({
        singletonKey: "default",
        general: {},
        experimental: { enableDoneExecutionGate: true },
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: { experimental: { enableDoneExecutionGate: true } },
      });
    const app = createApp(agentActor(companyId, agentId, runId));

    // No checkout run, no PR link, no durable artifact: the done-gate refuses
    // an agent narrating `done` without execution evidence. Nothing to do with
    // blockers — the row has none.
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Shipped it — writing up the details here." });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const details = res.body.details as Record<string, unknown>;

    // A different guard, not the blocker one.
    expect(details.reason).toBe("no_execution_run_and_no_pr_evidence");
    expect(details).not.toHaveProperty("unresolvedBlockerIssueIds");

    // Same announcement, and this guard's own details survive it.
    expect(
      details.commentPersisted,
      `the refusal must say the carried comment was not saved; got ${JSON.stringify(details)}`,
    ).toBe(false);
    expect(String(details.commentHint)).toContain("POST /api/issues/:id/comments");
    expect(details.issueId).toBe(issueId);

    expect(await commentRows(issueId)).toEqual([]);
  });

  // Review follow-up (#1895, second round): the four tests above all read
  // `res.body.details`, and every refusal they stage emits it. The
  // `missing-evidence` refusal does not. `middleware/error-handler.ts`
  // short-circuits `422 missing-evidence` into a narrow `{error, missing}`
  // body and never emits `details` at all, so the route built the
  // announcement and the handler dropped it on the floor — the PEN-3255
  // defect verbatim, surviving on the refusal an agent is most likely to hit,
  // since the documented loop is "attach evidence, then move to `in_review`"
  // and bundling the note into that same PATCH is the normal shape.
  //
  // So this one asserts on `res.body` directly rather than on
  // `res.body.details`. A fix applied only to the route would leave it red.
  it("announces the drop through the missing-evidence short-circuit, which emits no `details`", async () => {
    const { companyId, agentId, runId, issueId } = await seedEvidenceGatedIssue();
    const app = createApp(agentActor(companyId, agentId, runId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review", comment: "Screenshots are in the PR description rather than here." });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("missing-evidence");

    // The narrow contract this branch exists to serve is intact: `missing` is
    // still top-level, and `details` is still absent. The announcement is
    // carried through it, not by abandoning it.
    expect(res.body.missing).toEqual(expect.arrayContaining(["screenshot:1440x900"]));
    expect(res.body).not.toHaveProperty("details");

    expect(
      res.body.commentPersisted,
      `the refusal must say the carried comment was not saved; got ${JSON.stringify(res.body)}`,
    ).toBe(false);
    expect(String(res.body.commentHint)).toContain("POST /api/issues/:id/comments");

    expect(await commentRows(issueId)).toEqual([]);
  });

  // Complement, mirroring the blocker-guard pair above: the carry-through must
  // be tied to a comment having been carried. Without this, a handler change
  // that stamped the keys onto every `missing-evidence` refusal would pass the
  // test above while telling every agent in the evidence loop that a comment
  // it never sent was dropped. This is also the regression guard for the
  // existing `{error, missing}` exact-shape assertion in
  // `issues-patch-evidence.test.ts`.
  it("leaves the missing-evidence body untouched when the refused PATCH carried no comment", async () => {
    const { companyId, agentId, runId, issueId } = await seedEvidenceGatedIssue();
    const app = createApp(agentActor(companyId, agentId, runId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("missing-evidence");
    expect(res.body).not.toHaveProperty("commentPersisted");
    expect(res.body).not.toHaveProperty("commentHint");
  });
});
