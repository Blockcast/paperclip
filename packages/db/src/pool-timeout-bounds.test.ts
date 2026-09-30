import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  createDb,
  formatInheritedTimeoutSettings,
  readInheritedTimeoutSettings,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const EMBEDDED_TEST_TIMEOUT_MS = 60_000;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-pool-timeout-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

/**
 * Apply a database-scoped default. `ALTER DATABASE SET` sits below
 * startup-packet parameters in Postgres' GUC precedence, which is exactly the
 * relationship these tests exist to pin down.
 */
async function setDatabaseDefault(url: string, name: string, value: string): Promise<void> {
  const admin = postgres(url.replace(/\/paperclip$/, "/postgres"), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`ALTER DATABASE "paperclip" SET ${name} = '${value}'`);
  } finally {
    await admin.end();
  }
}

/** Read a GUC as milliseconds over a pool built by `createDb`. */
async function readPoolSettingMs(url: string, name: string): Promise<number> {
  const db = createDb(url);
  const rows = (await db.execute(
    sql`SELECT setting FROM pg_settings WHERE name = ${name}`,
  )) as unknown as Array<{ setting: string }>;
  return Number(rows[0]?.setting);
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

describeEmbeddedPostgres("createDb pool timeout bounds (PEN-3365)", () => {
  it(
    "binds idle_in_transaction_session_timeout on every pooled connection",
    async () => {
      const url = await createTempDatabase();

      // The bound has to actually reach the server. postgres.js filters falsy
      // startup parameters out of the packet entirely, so a `0` would ship no
      // bound at all while the code still reads as if it set one.
      await expect(readPoolSettingMs(url, "idle_in_transaction_session_timeout")).resolves.toBe(
        POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );
    },
    EMBEDDED_TEST_TIMEOUT_MS,
  );

  it(
    "does not set statement_timeout, so a server-side bound survives",
    async () => {
      const url = await createTempDatabase();
      await setDatabaseDefault(url, "statement_timeout", "30s");

      // The whole reason `statement_timeout` is left alone: a startup-packet
      // value OVERRIDES a server-side one rather than stacking with it, so
      // setting one here could raise an existing 30s bound to something looser
      // and call it an improvement. If someone adds one, this fails.
      await expect(readPoolSettingMs(url, "statement_timeout")).resolves.toBe(30_000);
    },
    EMBEDDED_TEST_TIMEOUT_MS,
  );

  it(
    "reports the inherited environment, not the pool's own override",
    async () => {
      const url = await createTempDatabase();
      await setDatabaseDefault(url, "idle_in_transaction_session_timeout", "7s");

      const inherited = await readInheritedTimeoutSettings(url);

      // The probe exists to answer "what does the server already impose?". If
      // it ever reads over the application pool it would report our own 120s
      // back to us — a reading that looks authoritative, is self-inflicted, and
      // destroys the only evidence the explicit-statement_timeout decision is
      // gated on. 7s here proves it read an uncontaminated connection.
      expect(inherited.idleInTransactionSessionTimeout.valueMs).toBe(7_000);
      expect(inherited.idleInTransactionSessionTimeout.valueMs).not.toBe(
        POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );

      // ...while the pool itself still carries the bound, confirming the
      // precedence claim above rather than merely asserting it in a comment.
      await expect(readPoolSettingMs(url, "idle_in_transaction_session_timeout")).resolves.toBe(
        POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );
    },
    EMBEDDED_TEST_TIMEOUT_MS,
  );

  it(
    "reports a disabled timeout as null rather than 0",
    async () => {
      const url = await createTempDatabase();

      const inherited = await readInheritedTimeoutSettings(url);

      // Postgres spells "unbounded" as 0, which is falsy and sorts below every
      // real bound — exactly the value most likely to be silently treated as
      // "a timeout is set". `null` forces the caller to handle it, and the
      // startup log branches to `warn` on it.
      expect(inherited.statementTimeout.valueMs).toBeNull();
      expect(inherited.statementTimeout.source).toBe("default");
      expect(formatInheritedTimeoutSettings(inherited)).toContain("statement_timeout=disabled");
    },
    EMBEDDED_TEST_TIMEOUT_MS,
  );
});
