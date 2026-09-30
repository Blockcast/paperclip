import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issueComments, issueCommentEffects, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import {
  claimEffect,
  completeEffect,
  enqueueCommentEffects,
  getEffectResult,
  hasUnsettledEffects,
  listCommentsWithResumableEffects,
  listSettledUnprocessedComments,
  listUnfinishedEffects,
  markCommentProcessedIfSettled,
  processCommentEffects,
  releaseEffect,
  renewEffectLease,
  resetLeaselessProcessing,
  MAX_EFFECT_ATTEMPTS,
  startIssueCommentEffectReconciler,
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

  async function makeEffectDue(effectId: string) {
    await db
      .update(issueCommentEffects)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(issueCommentEffects.id, effectId));
  }

  async function exhaustEffect(effectId: string) {
    for (let attempt = 1; attempt <= MAX_EFFECT_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await makeEffectDue(effectId);
      const claimed = await claimEffect(db as never, effectId);
      expect(claimed).not.toBeNull();
      await releaseEffect(db as never, claimed!, new Error("poison"));
    }
    const [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effectId));
    return row;
  }

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
      await completeEffect(db as never, claimed!);
    }
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(false);
    const [partial] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(partial.idempotencyProcessedAt).toBeNull();

    const last = await claimEffect(db as never, queued[2]!.id);
    await completeEffect(db as never, last!);
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
    await completeEffect(db as never, reclaimed!);

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

  it("backs off failures without settling the comment, including after the exhausted threshold", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [effect] = await listUnfinishedEffects(db as never, commentId);

    let current = (await claimEffect(db as never, effect.id))!;
    await releaseEffect(db as never, current, new Error("wake dispatch rejected"));
    let [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("queued");
    expect(row.lastError).toContain("wake dispatch rejected");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await claimEffect(db as never, effect.id)).toBeNull();

    // A retryable failure must keep the comment unprocessed — that is the whole
    // point: a swallowed dispatch rejection previously marked it done forever.
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(false);

    for (let i = 2; i <= MAX_EFFECT_ATTEMPTS; i += 1) {
      await makeEffectDue(effect.id);
      const next = await claimEffect(db as never, effect.id);
      expect(next).not.toBeNull();
      current = next!;
      await releaseEffect(db as never, current, new Error("still failing"));
    }
    [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("failed");
    expect(await claimEffect(db as never, effect.id)).toBeNull();
    expect(await listUnfinishedEffects(db as never, commentId)).toContainEqual(
      expect.objectContaining({ id: effect.id, status: "failed" }),
    );
    expect(await hasUnsettledEffects(db as never, commentId)).toBe(true);
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(false);
  }, 60_000);

  it("does not let a stale lease holder complete a reclaimed effect", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: [intents[0]] });
    const [effect] = await listUnfinishedEffects(db as never, commentId);
    const staleClaim = await claimEffect(db as never, effect.id, 1);
    expect(staleClaim).not.toBeNull();
    await db
      .update(issueCommentEffects)
      .set({ claimExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(issueCommentEffects.id, effect.id));
    const currentClaim = await claimEffect(db as never, effect.id);
    expect(currentClaim?.claimToken).not.toBe(staleClaim?.claimToken);

    await completeEffect(db as never, staleClaim!);
    let [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("processing");
    expect(row.claimToken).toBe(currentClaim?.claimToken);

    await completeEffect(db as never, currentClaim!);
    [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("processed");
  }, 60_000);

  it("publishes a result for a later effect to consume", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [sync] = await listUnfinishedEffects(db as never, commentId);
    const claimed = await claimEffect(db as never, sync.id);
    await completeEffect(db as never, claimed!, { addedReferencedIssues: ["BLO-1"] });

    // comment_activity embeds the reference diff and cannot recompute it after
    // references_sync has already run, so the diff has to survive on the row.
    expect(await getEffectResult(db as never, commentId, "references_sync")).toEqual({
      status: "processed",
      result: { addedReferencedIssues: ["BLO-1"] },
    });
  }, 60_000);

  it("renews a live claim so a slow-but-healthy worker is not reclaimed", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [effect] = await listUnfinishedEffects(db as never, commentId);
    // Short lease so the sink legitimately outlives it.
    const claimed = await claimEffect(db as never, effect.id, 40);
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Without renewal this row is now reclaimable even though its owner is alive.
    expect(await renewEffectLease(db as never, effect.id, claimed!.claimToken!, 60_000)).toBe(true);
    expect(await claimEffect(db as never, effect.id, 40)).toBeNull();
    expect(await completeEffect(db as never, claimed!)).toBe(true);
  }, 60_000);

  it("does not let a replica with a fast clock reclaim a live lease", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    // Claim *every* effect, so an expired lease is the only thing that could
    // make this comment look resumable. Leaving siblings `queued` would make the
    // reconciler assertion below pass for the wrong reason.
    const outstanding = await listUnfinishedEffects(db as never, commentId);
    const owners = [];
    for (const row of outstanding) {
      const owner = await claimEffect(db as never, row.id, 60_000);
      expect(owner).not.toBeNull();
      owners.push(owner!);
    }

    // Simulate a replica whose *application* clock runs 10 minutes fast while
    // the database clock is unchanged. When claim expiry was evaluated against
    // `new Date()`, this replica compared live 60s leases against a future
    // instant, reclaimed rows another worker still owned, and ran the same
    // non-idempotent sinks concurrently. Only `Date` is faked — the pg driver's
    // own timers must keep working.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 10 * 60_000));

      for (const owner of owners) {
        expect(await claimEffect(db as never, owner.id, 60_000)).toBeNull();
      }
      // The reconciler must not hand itself work it would then fail to claim.
      expect(await listCommentsWithResumableEffects(db as never, 10)).not.toContain(commentId);
    } finally {
      vi.useRealTimers();
    }

    // The genuine owners still hold their rows and can finish them.
    for (const owner of owners) {
      expect(await completeEffect(db as never, owner)).toBe(true);
    }
  }, 60_000);

  it("tells a worker that lost its lease that completion did not land", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const [effect] = await listUnfinishedEffects(db as never, commentId);
    const original = await claimEffect(db as never, effect.id, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The reconciler reclaims the expired row and becomes the real owner.
    const reclaimer = await claimEffect(db as never, effect.id, 60_000);
    expect(reclaimer).not.toBeNull();

    // The original worker must learn it no longer owns the row rather than
    // silently no-op'ing and walking on to later effects.
    expect(await completeEffect(db as never, original!, { from: "stale" })).toBe(false);
    expect(await renewEffectLease(db as never, effect.id, original!.claimToken!)).toBe(false);
    expect(await releaseEffect(db as never, original!, new Error("stale"))).toBe(false);

    const [row] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
    expect(row.status).toBe("processing");
    expect(row.claimToken).toBe(reclaimer!.claimToken);
    expect(row.result).toBeNull();
  }, 60_000);

  it("stops the pipeline on lost ownership instead of running later effects", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    const ordered = await listUnfinishedEffects(db as never, commentId);
    const executed: string[] = [];

    // The first sink outlives its lease and is reclaimed mid-flight. The loop
    // must abandon the run at that point: continuing would execute
    // comment_activity and wake alongside whoever now owns the first effect.
    const settled = await processCommentEffects(
      db as never,
      commentId,
      async (effect) => {
        executed.push(effect.effectKind);
        if (effect.effectKind === "references_sync") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          await claimEffect(db as never, effect.id, 60_000);
        }
        return null;
      },
      20,
    );

    expect(settled).toBe(false);
    expect(executed).toEqual(["references_sync"]);
    const rows = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.commentId, commentId));
    expect(rows.filter((row) => row.status === "processed")).toHaveLength(0);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(comment.idempotencyProcessedAt).toBeNull();
  }, 60_000);

  it("settles a comment whose effects all finished under different owners", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: intents });
    // Hand-off case: whoever completed the last effect was not the worker that
    // would have run settlement, so idempotency_processed_at is still null while
    // no row is left queued or lease-expired — invisible to the resumable query.
    for (const effect of await listUnfinishedEffects(db as never, commentId)) {
      const claimed = await claimEffect(db as never, effect.id);
      await completeEffect(db as never, claimed!);
    }
    const [before] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(before.idempotencyProcessedAt).toBeNull();
    expect(await listCommentsWithResumableEffects(db as never, 10)).not.toContain(commentId);

    // The settlement sweep is the only thing that can rescue it.
    expect(await listSettledUnprocessedComments(db as never, 10)).toContain(commentId);
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(true);
    const [after] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(after.idempotencyProcessedAt).not.toBeNull();
    expect(await listSettledUnprocessedComments(db as never, 10)).not.toContain(commentId);
  }, 60_000);

  it("reconciles an exhausted effect after durable backoff and settles only after recovery", async () => {
    await seed();
    await enqueueCommentEffects(db as never, { companyId, issueId, commentId, effects: [intents[0]] });
    const [effect] = await listUnfinishedEffects(db as never, commentId);
    const parked = await exhaustEffect(effect.id);
    expect(parked.status).toBe("failed");
    expect(await listCommentsWithResumableEffects(db as never, 10)).not.toContain(commentId);
    expect(await markCommentProcessedIfSettled(db as never, commentId)).toBe(false);
    const [before] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
    expect(before.idempotencyProcessedAt).toBeNull();

    // The durable failure backoff expires. The normal reconciler path must
    // reclaim the parked row, run its sink, and only then stamp the comment.
    await makeEffectDue(effect.id);
    expect(await listCommentsWithResumableEffects(db as never, 10)).toContain(commentId);

    const executed: string[] = [];
    const stop = startIssueCommentEffectReconciler(
      db as never,
      (candidateCommentId) => processCommentEffects(
        db as never,
        candidateCommentId,
        async (candidate) => {
          executed.push(candidate.id);
          return { recovered: true };
        },
      ),
      1,
    );
    try {
      await vi.waitFor(async () => {
        const [recovered] = await db.select().from(issueCommentEffects).where(eq(issueCommentEffects.id, effect.id));
        const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, commentId));
        expect(recovered.status).toBe("processed");
        expect(comment.idempotencyProcessedAt).not.toBeNull();
      }, { interval: 10, timeout: 5_000 });
    } finally {
      await stop();
    }
    expect(executed).toEqual([effect.id]);
  }, 60_000);
});
