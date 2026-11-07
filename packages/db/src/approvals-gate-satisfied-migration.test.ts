/**
 * PEN-5885: migration 0275 adds the column, and backfills it from the only
 * surviving trace the historical rows have — the reconciler's own `decision_note`.
 *
 * The backfill is the half worth testing. Its anchor is an English sentence, which
 * is exactly the fragile thing this column exists to stop downstream readers from
 * relying on; it is acceptable here, once, because the four templates are literal
 * strings in `closeAndAnnounce` with `satisfied` as their only input, and because
 * the alternative — leaving history unclassified — makes the fix unverifiable. With
 * no backfill the decision gauge only moves at the NEXT gate-satisfied closure,
 * which is unbounded in time and indistinguishable from the change not working.
 *
 * The third case is the one that matters most: a `cancelled` row NO gate
 * adjudicated must stay NULL, not become `false`. Null means "nothing measured
 * this"; `false` means "a gate ran and the ask died". The decision gauge excludes
 * both, so the distinction is invisible there — and that is precisely why a test
 * has to hold it, since nothing else will notice when it is lost.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0275_approvals_gate_satisfied.sql";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** Verbatim from `approval-gate-reconciler.ts`; the backfill anchors on these. */
const NOTE = {
  prMerged:
    "The gated pull request merged before a decision was recorded (Blockcast/paperclip#3461: "
    + "state=`closed`, merged=`true`). Closed by the approval-gate reconciler.",
  prClosedUnmerged:
    "The gated pull request was closed without merging, so the card has no live ask left "
    + "(Blockcast/paperclip#1058: state=`closed`, merged=`false`). If it is reopened and merged, "
    + "file a new card. Closed by the approval-gate reconciler.",
  runCompleted:
    "Gate completed before a decision was recorded (Blockcast/paperclip run 32338832082: "
    + "status=`completed`, conclusion=`success`). Closed by the approval-gate reconciler.",
  runDied:
    "Gate died undecided (Blockcast/paperclip run 32338832082: status=`completed`, "
    + "conclusion=`failure`). Closed by the approval-gate reconciler.",
  /** A human cancelling a card from the UI: no gate, no reconciler signature. */
  human: "Cancelled by the board; the ask was overtaken by events.",
} as const;

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

async function startDatabase(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return { database, sql };
}

/** Rewind to just before 0275 so `applyPendingMigrations` replays it over seeded rows. */
async function rewindToBeforeMigration(sql: postgres.Sql) {
  await sql.unsafe(`ALTER TABLE approvals DROP COLUMN IF EXISTS gate_satisfied`);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
}

async function seedCard(sql: postgres.Sql, status: string, note: string) {
  const [row] = await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO approvals (company_id, type, status, payload, decision_note, decided_at)
    VALUES ('${COMPANY}', 'request_board_approval', '${status}', '{}'::jsonb,
            ${note === "" ? "NULL" : `'${note.replace(/'/g, "''")}'`}, now())
    RETURNING id;
    SET session_replication_role = origin;
  `);
  return row;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("approvals gate_satisfied migration", () => {
  it("backfills true/false from the reconciler's notes and leaves everything else NULL", async () => {
    const { database, sql } = await startDatabase("paperclip-gate-satisfied-backfill-");
    await rewindToBeforeMigration(sql);

    await seedCard(sql, "cancelled", NOTE.prMerged);
    await seedCard(sql, "cancelled", NOTE.runCompleted);
    await seedCard(sql, "cancelled", NOTE.prClosedUnmerged);
    await seedCard(sql, "cancelled", NOTE.runDied);
    // NOT a gate closure. Must stay NULL -- `false` would assert a measurement
    // nobody took, and the two readings are not interchangeable.
    await seedCard(sql, "cancelled", NOTE.human);
    await seedCard(sql, "cancelled", "");
    // A decided card no gate ever touched, and one the requester retired.
    await seedCard(sql, "approved", "");
    await seedCard(sql, "withdrawn", "superseded by a newer card");

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const rows = await sql`
      SELECT status, decision_note, gate_satisfied FROM approvals ORDER BY status, decision_note NULLS FIRST
    `;
    const satisfied = rows.filter((r) => r.gate_satisfied === true).map((r) => r.decision_note);
    const died = rows.filter((r) => r.gate_satisfied === false).map((r) => r.decision_note);
    const unclassified = rows.filter((r) => r.gate_satisfied === null);

    expect(satisfied).toEqual(expect.arrayContaining([NOTE.prMerged, NOTE.runCompleted]));
    expect(satisfied).toHaveLength(2);
    expect(died).toEqual(expect.arrayContaining([NOTE.prClosedUnmerged, NOTE.runDied]));
    expect(died).toHaveLength(2);
    expect(unclassified).toHaveLength(4);
  }, 120_000);

  it("does not sweep up a non-reconciler note that merely opens with the same words", async () => {
    const { database, sql } = await startDatabase("paperclip-gate-satisfied-prefix-");
    await rewindToBeforeMigration(sql);
    // The prefix matches; the reconciler's trailing signature does not. A human
    // narrating the same event is not the reconciler recording a disposition.
    await seedCard(
      sql,
      "cancelled",
      "The gated pull request merged before a decision was recorded (I watched it happen).",
    );
    // `withdrawn` is out of scope even with a perfect reconciler note: the
    // reconciler never writes that status, so such a row is forged or corrupt and
    // the backfill must not launder it into a board decision.
    await seedCard(sql, "withdrawn", NOTE.prMerged);

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const rows = await sql`SELECT gate_satisfied FROM approvals`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.gate_satisfied === null)).toBe(true);
  }, 120_000);
});
