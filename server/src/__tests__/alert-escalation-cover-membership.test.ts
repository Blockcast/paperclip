import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issues,
  pluginDatabaseNamespaces,
  pluginMigrations,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  derivePluginDatabaseNamespace,
  pluginDatabaseService,
} from "../services/plugin-database.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres alert-escalation-cover-membership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ALERTMANAGER_PLUGIN_KEY = "paperclip-plugin-alertmanager";

function alertmanagerManifest(): PaperclipPluginManifestV1 {
  return {
    id: ALERTMANAGER_PLUGIN_KEY,
    apiVersion: 1,
    version: "0.2.0",
    displayName: "Alertmanager Webhook Receiver",
    description: "Test-local copy of the real manifest's database declaration.",
    author: "Paperclip",
    categories: ["connector", "automation"],
    capabilities: [
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
    ],
    entrypoints: { worker: "./dist/worker.js" },
    database: {
      namespaceSlug: "alertmanager",
      migrationsDir: "migrations",
      coreReadTables: ["companies", "issues"],
    },
  };
}

/**
 * BLO-16120: proves the migration this PR ships (`packages/plugins/paperclip-plugin-alertmanager/migrations/001_escalation_cover_membership.sql`)
 * applies cleanly through the production migration validator, and that the
 * atomic claim UPDATE `escalation.ts` uses to decide "who gets to post the
 * one resolution comment and run the terminal transition" is genuinely
 * race-safe against REAL concurrent Postgres connections — not just a JS
 * mock's cooperative-scheduling approximation (see the plugin's own
 * escalation.test.ts for that faster-running complement).
 */
describeEmbeddedPostgres("alert escalation cover membership (BLO-16120)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;
  let namespace!: string;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-alert-cover-membership-");
    db = createDb(tempDb.connectionString);

    const manifest = alertmanagerManifest();
    namespace = derivePluginDatabaseNamespace(manifest.id, manifest.database!.namespaceSlug);
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "plugins", "paperclip-plugin-alertmanager");

    pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });

    // Exercises the REAL migration file through the production validator —
    // if the SQL this PR ships doesn't pass `validatePluginMigrationStatement`
    // (unqualified schema refs, banned DDL, non-whitelisted public reads),
    // this throws and the suite fails here before any logic test runs.
    await pluginDatabaseService(db).applyMigrations(pluginId, manifest, packageRoot);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "${namespace}".alert_escalation_cover_members CASCADE`));
    await db.execute(sql.raw(`TRUNCATE TABLE "${namespace}".alert_escalation_covers CASCADE`));
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    await db.delete(pluginMigrations);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const [company] = await db.insert(companies).values({ name: "Test Co" }).returning();
    companyId = company!.id;
    return companyId;
  }

  async function seedIssue(cid: string, title: string): Promise<string> {
    const [issue] = await db.insert(issues).values({ companyId: cid, title }).returning();
    return issue!.id;
  }

  const pluginDb = () => pluginDatabaseService(db);
  const coversTable = () => `"${namespace}".alert_escalation_covers`;
  const membersTable = () => `"${namespace}".alert_escalation_cover_members`;

  async function insertCover(coverIssueId: string, cid: string, fingerprint: string) {
    await pluginDb().execute(
      pluginId,
      `INSERT INTO ${coversTable()} (cover_issue_id, company_id, dedup_fingerprint) VALUES ($1, $2, $3)`,
      [coverIssueId, cid, fingerprint],
    );
  }

  async function insertMember(coverIssueId: string, alertIssueId: string, resolved: boolean) {
    await pluginDb().execute(
      pluginId,
      `INSERT INTO ${membersTable()} (id, cover_issue_id, alert_issue_id, resolved_at) VALUES ($1, $2, $3, ${resolved ? "now()" : "NULL"})`,
      [randomUUID(), coverIssueId, alertIssueId],
    );
  }

  /** Mirrors the exact claim statement in `escalation.ts`'s `closeCoverIfEligible`. */
  async function attemptClaim(coverIssueId: string) {
    return pluginDb().execute(
      pluginId,
      `UPDATE ${coversTable()} AS c
       SET resolution_comment_posted_at = now(), updated_at = now()
       WHERE c.cover_issue_id = $1
         AND c.resolution_comment_posted_at IS NULL
         AND c.cancelled_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ${membersTable()} m
           WHERE m.cover_issue_id = c.cover_issue_id AND m.resolved_at IS NULL
         )`,
      [coverIssueId],
    );
  }

  it("applies the real migration and enforces the (cover_issue_id, alert_issue_id) membership uniqueness", async () => {
    const cid = await seedCompany();
    const coverIssueId = await seedIssue(cid, "[user-cover] test");
    const alertIssueId = await seedIssue(cid, "TestAlert firing");
    await insertCover(coverIssueId, cid, "cover:TestAlert:1");
    await insertMember(coverIssueId, alertIssueId, false);

    await expect(
      pluginDb().execute(
        pluginId,
        `INSERT INTO ${membersTable()} (id, cover_issue_id, alert_issue_id) VALUES ($1, $2, $3)`,
        [randomUUID(), coverIssueId, alertIssueId],
      ),
    ).rejects.toThrow();
  });

  it("the atomic claim UPDATE admits exactly one winner under genuinely concurrent connections", async () => {
    const cid = await seedCompany();
    const coverIssueId = await seedIssue(cid, "[user-cover] test");
    await insertCover(coverIssueId, cid, "cover:TestAlert:1");
    // No unresolved members — every concurrent claim attempt is eligible on
    // the predicate; only Postgres row-level locking should let exactly one
    // through.
    const CONCURRENCY = 25;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => attemptClaim(coverIssueId)),
    );
    const winners = results.filter((r) => r.rowCount > 0);
    expect(winners).toHaveLength(1);
    expect(results.reduce((sum, r) => sum + r.rowCount, 0)).toBe(1);
  });

  it("cover with an unresolved member rejects every concurrent claim attempt", async () => {
    const cid = await seedCompany();
    const coverIssueId = await seedIssue(cid, "[user-cover] test");
    const alertIssueId = await seedIssue(cid, "TestAlert firing");
    await insertCover(coverIssueId, cid, "cover:TestAlert:1");
    await insertMember(coverIssueId, alertIssueId, false);

    const results = await Promise.all(Array.from({ length: 10 }, () => attemptClaim(coverIssueId)));
    expect(results.every((r) => r.rowCount === 0)).toBe(true);
  });

  it("reconciliation query finds every stuck cover for a company beyond 50 rows — no silent truncation", async () => {
    const cid = await seedCompany();
    const STUCK_COUNT = 55;
    const NOISE_COUNT = 20; // already-cancelled covers that must NOT show up

    for (let i = 0; i < STUCK_COUNT; i += 1) {
      const coverIssueId = await seedIssue(cid, `[user-cover] stuck ${i}`);
      await insertCover(coverIssueId, cid, `cover:Stuck:${i}`);
      // Claimed (comment posted) but never finalized — the exact "durable
      // retry work" state a crash between comment and cancel leaves behind.
      await pluginDb().execute(
        pluginId,
        `UPDATE ${coversTable()} SET resolution_comment_posted_at = now() WHERE cover_issue_id = $1`,
        [coverIssueId],
      );
    }
    for (let i = 0; i < NOISE_COUNT; i += 1) {
      const coverIssueId = await seedIssue(cid, `[user-cover] cancelled ${i}`);
      await insertCover(coverIssueId, cid, `cover:Noise:${i}`);
      await pluginDb().execute(
        pluginId,
        `UPDATE ${coversTable()} SET resolution_comment_posted_at = now(), cancelled_at = now() WHERE cover_issue_id = $1`,
        [coverIssueId],
      );
    }

    // Mirrors `reconcileStuckCovers`'s query exactly (LIMIT 200 there).
    const stuck = await pluginDb().query<{ cover_issue_id: string }>(
      pluginId,
      `SELECT cover_issue_id FROM ${coversTable()} WHERE company_id = $1 AND resolution_comment_posted_at IS NOT NULL AND cancelled_at IS NULL LIMIT 200`,
      [cid],
    );
    expect(stuck).toHaveLength(STUCK_COUNT);
  });

  it("cascade lookup by alert_issue_id finds its cover among 60+ historical membership rows for other alerts", async () => {
    const cid = await seedCompany();
    const targetCoverId = await seedIssue(cid, "[user-cover] target");
    const targetAlertId = await seedIssue(cid, "TargetAlert firing");
    await insertCover(targetCoverId, cid, "cover:Target:1");
    await insertMember(targetCoverId, targetAlertId, false);

    for (let i = 0; i < 60; i += 1) {
      const otherCoverId = await seedIssue(cid, `[user-cover] other ${i}`);
      const otherAlertId = await seedIssue(cid, `OtherAlert ${i} firing`);
      await insertCover(otherCoverId, cid, `cover:Other:${i}`);
      await insertMember(otherCoverId, otherAlertId, true);
    }

    // Mirrors `recordSourceResolvedAndCloseCovers`'s membership lookup.
    const found = await pluginDb().query<{ cover_issue_id: string }>(
      pluginId,
      `SELECT DISTINCT cover_issue_id FROM ${membersTable()} WHERE alert_issue_id = $1`,
      [targetAlertId],
    );
    expect(found.map((r) => r.cover_issue_id)).toEqual([targetCoverId]);
  });
});
