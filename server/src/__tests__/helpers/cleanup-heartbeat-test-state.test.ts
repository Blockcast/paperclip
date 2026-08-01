import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./cleanup-heartbeat-test-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const cleanupLockKey = "paperclip:test-database-cleanup";

describeEmbeddedPostgres("cleanupHeartbeatTestState", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-lock-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("waits for the shared advisory lock before truncating", async () => {
    let releaseLock!: () => void;
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const blocker = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${cleanupLockKey}, 0))`);
      markLockHeld();
      await release;
    });
    await lockHeld;

    let cleanupFinished = false;
    const cleanup = cleanupHeartbeatTestState(db, {
      drainInFlightExecutions: async () => {},
    }).then(() => {
      cleanupFinished = true;
    });

    try {
      const lockWaitDeadline = Date.now() + 10_000;
      let cleanupIsWaitingForLock = false;
      while (Date.now() < lockWaitDeadline) {
        const waitingRows = await db.execute(sql<{ waiting: boolean }>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
              and query ~* 'pg_advisory_xact_lock'
          ) as waiting
        `);
        if (Array.from(waitingRows)[0]?.waiting) {
          cleanupIsWaitingForLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(cleanupIsWaitingForLock).toBe(true);
      expect(cleanupFinished).toBe(false);
    } finally {
      releaseLock();
      await blocker;
      await cleanup;
    }
    expect(cleanupFinished).toBe(true);
  });
});
