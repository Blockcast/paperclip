import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issueComments, issueCommentEffects, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  claimEffect,
  completeEffect,
  enqueueCommentEffects,
  getEffectResult,
  hasUnsettledEffects,
  listCommentsWithResumableEffects,
  listUnfinishedEffects,
  markCommentProcessedIfSettled,
  releaseEffect,
  resetLeaselessProcessing,
  MAX_EFFECT_ATTEMPTS,
} from "./issue-comment-effects.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-comment effect ledger tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue comment effect ledger", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let issueId: string;
  let commentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-effects-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueCommentEffects);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options?: { idempotencyKey?: string | null }) {
    companyId = randomUUID();
    issueId = randomUUID();
    commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ledger Co",
      issuePrefix: `L${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Durable effects",
      status: "in_progress",
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      body: "keyed comment",
      authorType: "agent",
      idempotencyKey: options?.idempotencyKey ?? "sweep:window:fingerprint",
    });
  }

  const intents = [
    { effectKind: "references_sync" as const, effectKey: "references_sync", payload: {} },
    { effectKind: "comment_activity" as const, effectKey: "comment_activity", payload: {} },
    { effectKind: "wake" as const, effectKey: "wake:agent-a", payload: { agentId: "agent-a" } },
  ];

  it("commits comment acceptance and effect intents atomically", async () => {
    companyId = randomUUID();
    issueId = randomUUID();
    commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Atomic Co",
      issuePrefix: `A${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Atomic", status: "in_progress" });

    // The comment insert and its effect intents share one transaction, so a
    // failure anywhere inside it must leave neither behind — never an accepted
    // comment that owes work no row records.
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(issueComments).values({
          id: commentId,
          companyId,
          issueId,
          body: "keyed comment",
          authorType: "agent",
          idempotencyKey: "atomic:key",
        });
        await enqueueCommentEffects(tx as never, { companyId, issueId, commentId, effects: intents });
        throw new Error("post-insert failure inside the accept transaction");
      }),
    ).rejects.toThrow("post-insert failure");

    expect(await db.select().from(issueComments).where(eq(issueComments.id, commentId))).toHaveLength(0);
    expect(
      await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.commentId, commentId)),
    ).toHaveLength(0);
  }, 60_000);

  it("gives exactly one concurrent claimer ownership of an effect", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [effect] = await listUnfinishedEffects(db as never, commentId);

    // Two same-key requests racing on the same effect row. The CAS predicate
    // must hand the row to exactly one of them; the loser has to skip rather
    // than re-run a side effect the winner is already executing.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimEffect(db as never, effect.id)),
    );
    const winners = results.filter((row) => row !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe("processing");
    expect(winners[0]!.attempts).toBe(1);
  }, 60_000);

  it("does not mark the comment processed while any effect is outstanding", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const queued = await listUnfinishedEffects(db as never, commentId);
    expect(queued).toHaveLength(3);

    for (const effect of queued.slice(0, 2)) {
      const claimed = await claimEffect(db as never, effect.id);
      await completeEffect(db as never, claimed!.id);
    }
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(false);
    const [partial] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(partial.idempotencyProcessedAt).toBeNull();

    const last = await claimEffect(db as never, queued[2]!.id);
    await completeEffect(db as never, last!.id);
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(true);
    const [settled] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(settled.idempotencyProcessedAt).not.toBeNull();
  }, 60_000);

  it("reclaims an effect whose owner died mid-flight and completes it once", async () => {
    await seed();
    // Single effect so "is this comment resumable?" reflects only this row.
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: [intents[0]] });
    const [effect] = await listUnfinishedEffects(db as never, commentId);

    // Simulate a crash: the claim is taken and the process dies without ever
    // completing or releasing it, leaving a live lease behind.
    const claimed = await claimEffect(db as never, effect.id, 60_000);
    expect(claimed).not.toBeNull();
    expect(await claimEffect(db as never, effect.id)).toBeNull();
    expect(await listCommentsWithResumableEffects(db as never, 10)).not.toContain(commentId);

    // Once the lease expires the reconciler can take over.
    await db
      .update(issueCommentEffects)
      .set({ claimExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(issueCommentEffects.id, effect.id));

    expect(await listCommentsWithResumableEffects(db as never, 10)).toContain(commentId);
    const reclaimed = await claimEffect(db as never, effect.id);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.attempts).toBe(2);
    await completeEffect(db as never, reclaimed!.id);

    // A completed effect is never handed out again, so the side effect runs once.
    expect(await claimEffect(db as never, effect.id)).toBeNull();
  }, 60_000);

  it("requeues a leaseless processing row so it cannot strand a comment", async () => {
    await seed();
    // Single effect so "is this comment resumable?" reflects only this row.
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: [intents[0]] });
    const [effect] = await listUnfinishedEffects(db as never, commentId);
    await db
      .update(issueCommentEffects)
      .set({ status: "processing", claimExpiresAt: null })
      .where(eq(issueCommentEffects.id, effect.id));

    expect(await listCommentsWithResumableEffects(db as never, 10)).not.toContain(commentId);
    expect(await resetLeaselessProcessing(db as never)).toBe(1);
    expect(await listCommentsWithResumableEffects(db as never, 10)).toContain(commentId);
  }, 60_000);

  it("re-enqueueing the same intents is a no-op", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    expect(await listUnfinishedEffects(db as never, commentId)).toHaveLength(3);
  }, 60_000);

  it("retries a released effect and parks it failed once attempts are exhausted", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [effect] = await listUnfinishedEffects(db as never, commentId);

    let current = (await claimEffect(db as never, effect.id))!;
    await releaseEffect(db as never, current, new Error("wake dispatch rejected"));
    let [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("queued");
    expect(row.lastError).toContain("wake dispatch rejected");

    // A retryable failure must keep the comment unprocessed — that is the whole
    // point: a swallowed dispatch rejection previously marked it done forever.
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(false);

    for (let i = 0; i < MAX_EFFECT_ATTEMPTS; i++) {
      const next = await claimEffect(db as never, effect.id);
      if (!next) break;
      current = next;
      await releaseEffect(db as never, current, new Error("still failing"));
    }
    [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("failed");
    expect(await claimEffect(db as never, effect.id)).toBeNull();
    expect(await hasUnsettledEffects(db as never, commentId)).toBe(true);
  }, 60_000);

  it("publishes a result for a later effect to consume", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [sync] = await listUnfinishedEffects(db as never, commentId);
    const claimed = await claimEffect(db as never, sync.id);
    await completeEffect(db as never, claimed!.id, { addedReferencedIssues: ["BLO-1"] });

    // comment_activity embeds the reference diff and cannot recompute it after
    // references_sync has already run, so the diff has to survive on the row.
    expect(await getEffectResult(db as never, commentId, "references_sync")).toEqual({
      status: "processed",
      result: { addedReferencedIssues: ["BLO-1"] },
    });
  }, 60_000);
});
