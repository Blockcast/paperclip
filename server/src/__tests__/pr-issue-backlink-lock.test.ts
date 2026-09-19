import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, POSTGRES_POOL_MAX } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __test_prIssueBackLinkLockKey,
  withPrIssueBackLinkLock,
} from "../services/pr-issue-backlink-lock.js";
import {
  __test_buildIssueBackLinkBody,
  __test_commentsContainBackLinkMarker,
} from "../routes/github-webhook.js";

/**
 * PEN-2865. The PR→issue back-link comment carries a hidden marker so it is
 * posted once, but the marker was consulted in a plain check-then-act: list the
 * comments, test for the marker, post. Two concurrent deliveries of one
 * `pull_request` event could both list before either posted, both see no
 * marker, and both post.
 *
 * Observed, not hypothesised: Blockcast/paperclip#1738 carries two
 * byte-identical back-link comments 2s apart (5617605074 @ 10:59:44Z,
 * 5617605503 @ 10:59:46Z).
 *
 * These tests use embedded Postgres deliberately. The fix is an advisory lock,
 * so a mocked db would pin nothing at all — it would assert that a function was
 * called, not that two callers actually exclude each other.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping PR back-link lock DB tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * A GitHub stand-in whose read and write are separated by a real await, which
 * is the check-then-act window the production code had. `postedCount` is the
 * invariant under test: the back-link may reach a PR at most once.
 */
function fakePrCommentSurface() {
  const comments: string[] = [];
  let postedCount = 0;
  return {
    get postedCount() {
      return postedCount;
    },
    get comments() {
      return [...comments];
    },
    /** Mirrors the webhook block: list bodies, test the marker, post if absent. */
    async readMarkerThenPost(): Promise<void> {
      const existing = [...comments];
      // Yield so a second, unserialized caller reads this same pre-post state.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (__test_commentsContainBackLinkMarker(existing)) return;
      comments.push(
        __test_buildIssueBackLinkBody("https://p.example", [{ identifier: "PEN-2865", issuePrefix: "PEN" }]),
      );
      postedCount += 1;
    },
  };
}

/** Walk the cause chain for a Postgres SQLSTATE, which Drizzle wraps. */
function postgresErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

describeEmbeddedPostgres("PR→issue back-link is posted at most once per PR (PEN-2865)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-backlink-lock-");
    db = createDb(tempDb.connectionString);
  }, 240_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("NEGATIVE CONTROL: without the lock, two concurrent deliveries both post", async () => {
    const surface = fakePrCommentSurface();

    await Promise.all([surface.readMarkerThenPost(), surface.readMarkerThenPost()]);

    // If this ever reads 1, the harness has stopped reproducing the defect and
    // the passing test below would prove nothing.
    expect(surface.postedCount).toBe(2);
  });

  it("serializes two concurrent deliveries of one PR so only the first posts", async () => {
    const surface = fakePrCommentSurface();
    const ref = { repoFullName: "Blockcast/paperclip", prNumber: 1738 };

    await Promise.all([
      withPrIssueBackLinkLock(db, ref, () => surface.readMarkerThenPost()),
      withPrIssueBackLinkLock(db, ref, () => surface.readMarkerThenPost()),
    ]);

    expect(surface.postedCount).toBe(1);
    expect(surface.comments).toHaveLength(1);
  });

  it("serializes across repo-name casing, which hashes to one lock id", async () => {
    const surface = fakePrCommentSurface();

    // GitHub owner/repo identity is case-insensitive and the producers spell it
    // differently; comparing bytes would hash to two lock ids and let the pair
    // race straight through the gate meant to stop them.
    await Promise.all([
      withPrIssueBackLinkLock(db, { repoFullName: "Blockcast/paperclip", prNumber: 1738 }, () =>
        surface.readMarkerThenPost(),
      ),
      withPrIssueBackLinkLock(db, { repoFullName: "blockcast/PAPERCLIP", prNumber: 1738 }, () =>
        surface.readMarkerThenPost(),
      ),
    ]);

    expect(surface.postedCount).toBe(1);
  });

  it("scopes the lock per PR, so a different PR is not blocked behind it", async () => {
    // Each critical section waits for the other to enter. If the lock were
    // scoped wider than one PR they would deadlock; the timeout turns that
    // into a named failure instead of a hang. It is deliberately short: a
    // regression here is a deadlock, which is immediate and total, so waiting
    // longer cannot turn a failure into a pass — it would only burn most of
    // the worker timeout before reporting what it already knew.
    let enteredA!: () => void;
    let enteredB!: () => void;
    const aEntered = new Promise<void>((resolve) => (enteredA = resolve));
    const bEntered = new Promise<void>((resolve) => (enteredB = resolve));

    const bothRan = Promise.all([
      withPrIssueBackLinkLock(db, { repoFullName: "Blockcast/paperclip", prNumber: 1738 }, async () => {
        enteredA();
        await bEntered;
      }),
      withPrIssueBackLinkLock(db, { repoFullName: "Blockcast/paperclip", prNumber: 1739 }, async () => {
        enteredB();
        await aEntered;
      }),
    ]);

    await expect(
      Promise.race([
        bothRan,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("distinct PRs deadlocked: the lock is scoped too widely")), 2_000),
        ),
      ]),
    ).resolves.toBeDefined();
  }, 30_000);

  it("bounds a waiter's queue time, so a hung GitHub call cannot pin the pool", async () => {
    // The critical section performs uncapped GitHub I/O (neither
    // githubListIssueCommentBodies nor githubPostIssueComment passes an
    // AbortSignal), so the holder sits idle-in-transaction pinning a pool
    // connection — and every delivery queued behind it on an *untimed*
    // pg_advisory_xact_lock pins one too. A burst of concurrent PR-open
    // deliveries would then occupy the whole pool and starve unrelated work,
    // and because the holder could no longer get a connection to finish, the
    // lock would never be released. Reproduced here against the real
    // production pool size (createDb uses POSTGRES_POOL_MAX), so this is the
    // burst the finding names rather than a scaled-down proxy: a holder whose
    // GitHub call never returns, and enough concurrent deliveries to fill the
    // rest of the pool.
    const poolDb = createDb(tempDb!.connectionString);
    const ref = { repoFullName: "Blockcast/paperclip", prNumber: 1741 };

    let releaseHungCall!: () => void;
    const hungCall = new Promise<void>((resolve) => (releaseHungCall = resolve));
    let holderEntered!: () => void;
    const entered = new Promise<void>((resolve) => (holderEntered = resolve));

    const holder = withPrIssueBackLinkLock(
      poolDb,
      ref,
      async () => {
        holderEntered();
        await hungCall;
      },
      // Long hold bound: this test is about the waiters, so the holder must
      // still be stuck when they are asserted on.
      { holdMs: 60_000 },
    );

    try {
      await entered;

      const waiters = Array.from({ length: POSTGRES_POOL_MAX - 1 }, () =>
        withPrIssueBackLinkLock(poolDb, ref, async () => "posted", { waitMs: 300 }),
      );
      const settled = await Promise.allSettled(waiters);

      // The bound fired: each waiter gave its connection back instead of
      // queueing on the hung holder forever. 55P03 is lock_not_available, i.e.
      // lock_timeout specifically — not some incidental failure that would let
      // this pass for the wrong reason. Drizzle wraps the driver error, so the
      // code is read off the cause chain rather than the thrown object.
      for (const outcome of settled) {
        expect(outcome.status).toBe("rejected");
        const reason = outcome.status === "rejected" ? outcome.reason : null;
        expect(postgresErrorCode(reason)).toBe("55P03");
      }

      // ...and the pool is usable for unrelated work while the holder is still
      // hung, which is the property the bound exists to preserve.
      await expect(
        Promise.race([
          poolDb.execute(sql`select 1 as ok`),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("unrelated DB work starved: lock waiters pinned the pool")),
              5_000,
            ),
          ),
        ]),
      ).resolves.toBeDefined();
    } finally {
      releaseHungCall();
      await holder.catch(() => {});
    }
  }, 60_000);

  it("keys the lock on the normalized repo and the PR number", () => {
    expect(__test_prIssueBackLinkLockKey({ repoFullName: "  Blockcast/Paperclip ", prNumber: 1738 })).toBe(
      "github:pr-issue-backlink:blockcast/paperclip:1738",
    );
    expect(__test_prIssueBackLinkLockKey({ repoFullName: "Blockcast/paperclip", prNumber: 1739 })).not.toBe(
      __test_prIssueBackLinkLockKey({ repoFullName: "Blockcast/paperclip", prNumber: 1738 }),
    );
  });
});
