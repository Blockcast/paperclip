/**
 * Verifies the BLO-19124 legacy wake-bounds backfill.
 *
 * The migration exists because a recovery action with `max_attempts IS NULL`
 * is not merely unbounded, it is unretirable: `escalateExpiredWakeHorizons`
 * requires both `max_attempts` and `timeout_at` to be non-null, so it can never
 * select the row, which then holds `issue_recovery_actions_active_source_uq`
 * and pins its source issue `blocked` with no wake path.
 *
 * Each case below pins one conjunct of the migration's WHERE clause, because
 * the predicate is the part that is easy to get wrong in the damaging
 * direction. In particular the `wake_owner` conjunct is NOT a stylistic
 * alternative to `max_attempts IS NULL`: a null budget is deliberate for the
 * wake policies that wake nobody (`manual_repair_required`, `monitor_only`,
 * `board_escalation`), and bounding those would start retiring rows whose
 * whole contract is that they wait for a human.
 *
 * Located by suffix, not by number: the leading 4-digit number is a rebase
 * coordinate master reassigns whenever another migration lands first.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_SUFFIX = "_issue_recovery_action_legacy_wake_bounds.sql";
const MIGRATION_FILE = resolveMigrationFile();
const CREATED_AT = "2026-06-05T00:00:00.000Z";
const EXPECTED_TIMEOUT_AT = "2026-06-05T06:00:00.000Z";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function resolveMigrationFile() {
  const matches = fs
    .readdirSync(new URL("./migrations/", import.meta.url))
    .filter((entry) => entry.endsWith(MIGRATION_SUFFIX))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one migration ending in "${MIGRATION_SUFFIX}", found ${matches.length}${
        matches.length > 0 ? `: ${matches.join(", ")}` : ""
      }`,
    );
  }
  return matches[0]!;
}

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping legacy wake-bounds migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery action legacy wake bounds migration", () => {
  it("bounds only unbounded active owner-waking actions, and replays as a no-op", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-legacy-wake-bounds-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const companyId = randomUUID();
    const agentId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Legacy Wake Bounds', 'LWB')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES (${agentId}, ${companyId}, 'Owner', 'engineer', 'process', '{}'::jsonb)
    `;

    // One issue per action: `issue_recovery_actions_active_source_uq` admits a
    // single active-or-escalated action per source issue.
    const seed = async (
      label: string,
      row: { status: string; maxAttempts: number | null; wakePolicyType: string },
    ) => {
      const issueId = randomUUID();
      const actionId = randomUUID();
      await sql`
        INSERT INTO "issues" ("id", "company_id", "title", "identifier")
        VALUES (${issueId}, ${companyId}, ${`Issue ${label}`}, ${`LWB-${label}`})
      `;
      await sql`
        INSERT INTO "issue_recovery_actions" (
          "id", "company_id", "source_issue_id", "kind", "status", "owner_agent_id",
          "cause", "fingerprint", "next_action", "wake_policy", "max_attempts",
          "timeout_at", "created_at", "updated_at"
        ) VALUES (
          ${actionId}, ${companyId}, ${issueId}, 'stranded_assigned_issue', ${row.status},
          ${agentId}, 'stranded_assigned_issue', ${`fp-${label}`}, 'restore a live execution path',
          ${sql.json({ type: row.wakePolicyType })}, ${row.maxAttempts},
          NULL, ${CREATED_AT}, ${CREATED_AT}
        )
      `;
      return actionId;
    };

    const bounded = await seed("A", {
      status: "active",
      maxAttempts: null,
      wakePolicyType: "wake_owner",
    });
    // Deliberately null: this policy wakes nobody and waits on a human.
    const manualRepair = await seed("B", {
      status: "active",
      maxAttempts: null,
      wakePolicyType: "manual_repair_required",
    });
    // Already retired by the 0241 delivery-bounds migration.
    const escalated = await seed("C", {
      status: "escalated",
      maxAttempts: null,
      wakePolicyType: "wake_owner",
    });
    // Already bounded: the backfill must not overwrite a live budget. The null
    // `timeout_at` asserted for this row below is NOT an accepted residual — it
    // guards against an over-broad match. No producer can mint `max_attempts`
    // non-null alongside a null `timeout_at`: both creation sites take the pair
    // from one `recoveryActionBoundsAtCreation` object
    // (`recovery/service.ts:5954-5955` and `:14906`), so the two columns are
    // always written together or not at all.
    const alreadyBounded = await seed("D", {
      status: "active",
      maxAttempts: 3,
      wakePolicyType: "wake_owner",
    });

    const readAction = async (id: string) => {
      const rows = await sql<
        { max_attempts: number | null; timeout_at: Date | null; updated_at: Date }[]
      >`
        SELECT "max_attempts", "timeout_at", "updated_at"
        FROM "issue_recovery_actions"
        WHERE "id" = ${id}
      `;
      return rows[0]!;
    };

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const boundedAfter = await readAction(bounded);
    expect(boundedAfter.max_attempts).toBe(5);
    // Creation-anchored, exactly as `recoveryActionBoundsAtCreation` computes
    // it — so this grants no new budget, it only makes the row selectable by
    // the retirement sweep that has never been able to see it.
    expect(boundedAfter.timeout_at?.toISOString()).toBe(EXPECTED_TIMEOUT_AT);

    for (const [label, id] of [
      ["manual_repair_required", manualRepair],
      ["escalated", escalated],
    ] as const) {
      const after = await readAction(id);
      expect(`${label}:${after.max_attempts}`).toBe(`${label}:null`);
      expect(`${label}:${after.timeout_at}`).toBe(`${label}:null`);
    }
    expect((await readAction(alreadyBounded)).max_attempts).toBe(3);
    expect((await readAction(alreadyBounded)).timeout_at).toBeNull();

    // Replay: the predicate no longer selects the row it bounded, so a second
    // apply must not touch it at all. `updated_at` is the witness — a migration
    // that re-ran would move it.
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    await applyPendingMigrations(database.connectionString);
    const boundedReplayed = await readAction(bounded);
    expect(boundedReplayed.max_attempts).toBe(5);
    expect(boundedReplayed.timeout_at?.toISOString()).toBe(EXPECTED_TIMEOUT_AT);
    expect(boundedReplayed.updated_at.toISOString()).toBe(
      boundedAfter.updated_at.toISOString(),
    );
  }, 90_000);
});
