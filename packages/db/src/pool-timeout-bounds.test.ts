import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_ROLE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  createDb,
  formatInheritedTimeoutSettings,
  poolIdleInTransactionTimeoutLoosens,
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

/**
 * Deliberately NOT inside `describeEmbeddedPostgres`. These are static
 * assertions about two constants, so they must still run — and still fail — on
 * a runner where embedded Postgres is unavailable and every test below skips.
 * A guard that silently skips on the machine that would have caught the raise
 * is not a guard.
 */
describe("createDb idle-in-transaction bound never loosens the server's (PEN-3365)", () => {
  it("does not exceed the idle-in-transaction bound the role already imposes", () => {
    // The regression this exists for: between #1921 and PEN-3365 the pool
    // shipped 120_000 against a role-level 60_000, and because startup-packet
    // parameters outrank `ALTER ROLE`, that RAISED the live bound fleet-wide.
    // The change was made *for* PEN-3365 and loosened the exact protection
    // PEN-3365 exists to provide. Raising this constant again fails here.
    expect(POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeLessThanOrEqual(
      POSTGRES_ROLE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    );
  });

  it("keeps the two figures independent so the bound above can actually fail", () => {
    // If `POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS` were an alias of the role
    // constant the assertion above would hold by construction and catch
    // nothing. Pinning the literal is what keeps it load-bearing.
    expect(POSTGRES_ROLE_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(60_000);
    expect(POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(60_000);
  });

  it("reports a tighter inherited bound as a loosening, and an absent one as not", () => {
    const at = (valueMs: number | null) => ({
      statementTimeout: { name: "statement_timeout", valueMs: 30_000, source: "user" },
      idleInTransactionSessionTimeout: {
        name: "idle_in_transaction_session_timeout",
        valueMs,
        source: valueMs === null ? "default" : "user",
      },
      lockTimeout: { name: "lock_timeout", valueMs: 15_000, source: "user" },
    });

    // Tighter server bound => we would be overriding it upward.
    expect(poolIdleInTransactionTimeoutLoosens(at(30_000))).toBe(true);
    expect(formatInheritedTimeoutSettings(at(30_000))).toContain("LOOSENED");

    // Equal is the shipped state, and is not a loosening.
    expect(
      poolIdleInTransactionTimeoutLoosens(at(POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS)),
    ).toBe(false);

    // Disabled (Postgres spells it `0`, surfaced as null) is the case the
    // startup parameter exists for: there is no bound to loosen, so shipping
    // one is strictly an improvement and must not be reported as a regression.
    expect(poolIdleInTransactionTimeoutLoosens(at(null))).toBe(false);
    expect(formatInheritedTimeoutSettings(at(null))).not.toContain("LOOSENED");

    // Negative control: the unremarkable case still renders plainly, so the
    // marker above is attributable to the comparison and not to the format
    // function simply always appending it.
    expect(formatInheritedTimeoutSettings(at(60_000))).not.toContain("LOOSENED");
  });
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
      // it ever reads over the application pool it would report our own bound
      // back to us — a reading that looks authoritative, is self-inflicted, and
      // destroys the only evidence the explicit-statement_timeout decision is
      // gated on. 7s here proves it read an uncontaminated connection.
      //
      // 7s is also deliberately TIGHTER than the pool's bound, so this doubles
      // as the end-to-end case for the loosening check: a server value the pool
      // would override upward is exactly the PEN-3365 regression.
      expect(inherited.idleInTransactionSessionTimeout.valueMs).toBe(7_000);
      expect(inherited.idleInTransactionSessionTimeout.valueMs).not.toBe(
        POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      );
      expect(poolIdleInTransactionTimeoutLoosens(inherited)).toBe(true);
      expect(formatInheritedTimeoutSettings(inherited)).toContain("LOOSENED");

      // ...while the pool itself still carries the bound, confirming the
      // precedence claim above rather than merely asserting it in a comment.
      // This is the mechanism that made the 120s regression fleet-wide: the
      // startup packet wins over `ALTER DATABASE`/`ALTER ROLE`, so a pool value
      // looser than the server's silently replaces it.
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
