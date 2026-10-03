import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";

// PEN-3743: a coalesced issue wake inlines only the issue's newest comment, so
// every earlier order it absorbed reaches the agent as silence. The ids are NOT
// lost -- `mergeCoalescedContextSnapshot` accumulates them into `wakeCommentIds`
// and they survive deferral and promotion -- but nothing read them back out, and
// the `commentWindow` ledger was computed from the POST-override list, so it
// reported `missingCount: 0` / `fallbackFetchNeeded: false` on a payload that
// had dropped N-1 orders.
//
// Measured on PEN-3743 itself, 2026-10-03: two comments 34s apart, both in
// `wakeCommentIds`, one delivered, the ledger reporting the result as whole.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres coalesced wake comment surfacing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("coalesced wake comment surfacing", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-coalesced-wake-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueWithComments(bodies: string[]) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Coalesced Wake Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "CW-1",
      title: "Coalesced wake surfacing",
      status: "in_progress",
      priority: "high",
    });

    const commentIds: string[] = [];
    // Distinct, strictly increasing createdAt so "newest" is unambiguous --
    // buildPaperclipWakePayload orders by (createdAt desc, id desc).
    for (const [index, body] of bodies.entries()) {
      const id = randomUUID();
      commentIds.push(id);
      await db.insert(issueComments).values({
        id,
        companyId,
        issueId,
        authorUserId: "board-user-1",
        body,
        createdAt: new Date(Date.UTC(2026, 9, 3, 12, 45, index)),
      });
    }
    return { companyId, issueId, commentIds };
  }

  it("names the absorbed comments it did not inline, and admits a fetch is needed", async () => {
    const { companyId, issueId, commentIds } = await seedIssueWithComments([
      "the ruling",
      "the correction",
    ]);
    const [rulingId, correctionId] = commentIds as [string, string];

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        // What a coalesce actually leaves on the run row.
        wakeCommentIds: [rulingId, correctionId],
        wakeCommentId: correctionId,
        commentId: correctionId,
      },
    });

    // The freshness override is preserved: only the newest body is inlined.
    expect(payload?.commentIds).toEqual([correctionId]);
    expect(payload?.comments).toHaveLength(1);
    expect(payload?.comments?.[0]?.body).toBe("the correction");

    // ...but the drop is now named rather than silent.
    expect(payload?.commentWindow).toMatchObject({
      requestedCount: 1,
      includedCount: 1,
      missingCount: 0,
      supersededCount: 1,
      supersededCommentIds: [rulingId],
    });
    // The field that previously asserted completeness over a lossy payload.
    expect(payload?.fallbackFetchNeeded).toBe(true);
  });

  it("reports no supersession when the wake carried a single comment", async () => {
    const { companyId, issueId, commentIds } = await seedIssueWithComments(["only comment"]);
    const [onlyId] = commentIds as [string];

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentIds: [onlyId],
        wakeCommentId: onlyId,
      },
    });

    expect(payload?.commentIds).toEqual([onlyId]);
    expect(payload?.commentWindow).toMatchObject({
      supersededCount: 0,
      supersededCommentIds: [],
    });
    expect(payload?.fallbackFetchNeeded).toBe(false);
  });

  it("counts a newer non-wake comment as superseding every absorbed id", async () => {
    // The override re-queries the issue's newest comment, which need not be one
    // of the coalesced ones at all -- a comment posted after the wake was
    // deferred displaces the entire absorbed set. Both absorbed orders must then
    // be named, not just the older one.
    const { companyId, issueId, commentIds } = await seedIssueWithComments([
      "first order",
      "second order",
      "unrelated later comment",
    ]);
    const [firstId, secondId] = commentIds as [string, string, string];

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        wakeCommentIds: [firstId, secondId],
        wakeCommentId: secondId,
      },
    });

    expect(payload?.comments?.[0]?.body).toBe("unrelated later comment");
    expect(payload?.commentWindow).toMatchObject({
      supersededCount: 2,
      supersededCommentIds: [firstId, secondId],
    });
    expect(payload?.fallbackFetchNeeded).toBe(true);
  });
});
