/**
 * Ally review of PR #1145 — `listJobsWithFailureStreak` computed its streak
 * over a job's whole run history, but the BLO-20957 fan-out turned one tick
 * into one run row *per configured company*. That combination is wrong in
 * both directions, and both directions are exercised here:
 *
 *  - **False page** — three companies each failing once on the same tick
 *    write three consecutive `failed` rows, indistinguishable from one
 *    company failing three ticks running.
 *  - **Missed page** — one company failing forever stays hidden whenever a
 *    healthy company's `succeeded` row interleaves ahead of it. This is the
 *    dangerous direction: a permanently broken tenant reads as healthy.
 *
 * These run against a real Postgres because the fix is SQL-shaped
 * (`selectDistinct` + a per-company window with a deterministic tiebreak);
 * a mocked `db` would assert the shape of the query rather than its result.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  companies,
  plugins,
  pluginJobs,
  pluginJobRuns,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin job failure-streak tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "listJobsWithFailureStreak partitions by company (BLO-20957 review)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    const pluginId = randomUUID();
    const jobId = randomUUID();
    const companyA = randomUUID();
    const companyB = randomUUID();
    const companyC = randomUUID();

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-plugin-job-streak-",
      );
      db = createDb(tempDb.connectionString);

      // `issue_prefix` is uniquely indexed and defaults to "PAP", so each
      // company needs its own.
      for (const [id, name, issuePrefix] of [
        [companyA, "Company A", "STKA"],
        [companyB, "Company B", "STKB"],
        [companyC, "Company C", "STKC"],
      ] as const) {
        await db.insert(companies).values({ id, name, issuePrefix });
      }

      await db.insert(plugins).values({
        id: pluginId,
        pluginKey: "paperclip-plugin-alertmanager",
        packageName: "@paperclipai/paperclip-plugin-alertmanager",
        version: "1.0.0",
        manifestJson: {} as never,
        status: "ready",
      });

      await db.insert(pluginJobs).values({
        id: jobId,
        pluginId,
        jobKey: "check-alert-escalations",
        schedule: "* * * * *",
        status: "active",
      });
    }, 120_000);

    afterEach(async () => {
      await db.delete(pluginJobRuns);
    });

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    /**
     * Insert a run. `createdAt` is passed explicitly so ordering is under the
     * test's control; identical timestamps are deliberate in the
     * single-tick case.
     */
    async function insertRun(
      companyId: string | null,
      status: "succeeded" | "failed",
      createdAt: Date,
      error: string | null = null,
    ) {
      await db.insert(pluginJobRuns).values({
        jobId,
        pluginId,
        companyId,
        trigger: "schedule",
        status,
        error,
        createdAt,
      });
    }

    const t = (offsetSeconds: number) =>
      new Date(Date.UTC(2026, 7, 9, 0, 0, offsetSeconds));

    it("does NOT page when three companies each fail once on the same tick", async () => {
      // One bad tick across three tenants — three consecutive `failed` rows,
      // but no tenant has a streak. Pre-fix this pages immediately.
      await insertRun(companyA, "failed", t(0), "boom");
      await insertRun(companyB, "failed", t(0), "boom");
      await insertRun(companyC, "failed", t(0), "boom");

      const streaks = await pluginJobStore(db).listJobsWithFailureStreak(3);

      expect(streaks).toHaveLength(0);
    });

    it("DOES page the one tenant failing every tick, even while others succeed", async () => {
      // Interleaved so a naive "last 3 runs for this job" window is never
      // all-failed. Pre-fix this is invisible — the dangerous direction.
      await insertRun(companyA, "failed", t(1), "company context is required");
      await insertRun(companyB, "succeeded", t(2));
      await insertRun(companyA, "failed", t(3), "company context is required");
      await insertRun(companyB, "succeeded", t(4));
      await insertRun(companyA, "failed", t(5), "company context is required");
      await insertRun(companyB, "succeeded", t(6));

      const streaks = await pluginJobStore(db).listJobsWithFailureStreak(3);

      expect(streaks).toHaveLength(1);
      expect(streaks[0]?.companyId).toBe(companyA);
      expect(streaks[0]?.consecutiveFailures).toBe(3);
      expect(streaks[0]?.lastError).toContain("company context is required");
    });

    it("reports each failing tenant separately when two are broken", async () => {
      for (const seconds of [1, 2, 3]) {
        await insertRun(companyA, "failed", t(seconds), "a-broke");
        await insertRun(companyB, "failed", t(seconds), "b-broke");
        await insertRun(companyC, "succeeded", t(seconds));
      }

      const streaks = await pluginJobStore(db).listJobsWithFailureStreak(3);

      expect(streaks).toHaveLength(2);
      expect(streaks.map((s) => s.companyId).sort()).toEqual(
        [companyA, companyB].sort(),
      );
    });

    it("clears the streak for a tenant whose most recent run recovered", async () => {
      await insertRun(companyA, "failed", t(1), "boom");
      await insertRun(companyA, "failed", t(2), "boom");
      await insertRun(companyA, "failed", t(3), "boom");
      await insertRun(companyA, "succeeded", t(4));

      const streaks = await pluginJobStore(db).listJobsWithFailureStreak(3);

      expect(streaks).toHaveLength(0);
    });

    it("streaks instance-scoped runs in their own bucket rather than dropping them", async () => {
      // `companyId IS NULL` is how the fail-closed enumeration path records
      // its failures, so it must be alertable too.
      await insertRun(null, "failed", t(1), "Failed to enumerate configured companies");
      await insertRun(null, "failed", t(2), "Failed to enumerate configured companies");
      await insertRun(null, "failed", t(3), "Failed to enumerate configured companies");

      const streaks = await pluginJobStore(db).listJobsWithFailureStreak(3);

      expect(streaks).toHaveLength(1);
      expect(streaks[0]?.companyId).toBeNull();
    });

    it("is stable across polls when a fan-out writes identical timestamps", async () => {
      // A real fan-out writes its rows within the same millisecond. Ordering
      // on createdAt alone is non-deterministic there, so the streak could
      // flap between polls on identical data; `id` is the tiebreak.
      for (const company of [companyA, companyB, companyC]) {
        await insertRun(company, "failed", t(0), "same-tick");
        await insertRun(company, "failed", t(0), "same-tick");
        await insertRun(company, "failed", t(0), "same-tick");
      }

      const store = pluginJobStore(db);
      const first = await store.listJobsWithFailureStreak(3);
      const second = await store.listJobsWithFailureStreak(3);

      expect(first).toHaveLength(3);
      expect(first.map((s) => s.companyId).sort()).toEqual(
        second.map((s) => s.companyId).sort(),
      );
    });
  },
);
