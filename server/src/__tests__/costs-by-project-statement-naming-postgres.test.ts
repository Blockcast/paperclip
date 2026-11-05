import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb } from "@paperclipai/db";

import { costService } from "../services/costs.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * PEN-5653 — pin the driver invariant that two closed negatives rest on.
 *
 * PEN-5613 and PEN-5606 both close as negatives, and both rest on one property
 * that nothing in this repo enforces:
 *
 *   Drizzle's postgres-js driver executes every query through
 *   `client.unsafe(query, params)`, and `unsafe()` hardcodes `prepare: false`
 *   (`postgres@3.4.9/src/index.js:131-139`, before the options spread, so a
 *   client-level `prepare: true` cannot override it —
 *   `src/connection.js:251` gives the query-level flag precedence). The
 *   statement is therefore **unnamed**: `connection.js:260` assigns `''` and
 *   `:713` never caches it. Postgres re-Parses it on every execution and plans
 *   it with the actual parameter values at Bind time, so `num_custom_plans`
 *   never reaches 5 and a generic plan is never built.
 *
 * Consequence if that stops being true — a `drizzle-orm` or `postgres` bump, or
 * a driver that honours `.prepare(name)` (today Drizzle accepts a statement
 * name at `postgres-js/session.js:87` and silently drops it, its
 * `PostgresJsPreparedQuery` ctor having no such parameter):
 *
 *   - `byProject` starts promoting to a generic plan at execution #6, measured
 *     at ~1.7x slower than the custom plan it abandons, and immune to every
 *     index and statistics fix;
 *   - PEN-5613's verdict ("production cannot promote this statement") becomes
 *     wrong;
 *   - PEN-5643's case for `CREATE STATISTICS` as a standalone lever — which
 *     holds precisely BECAUSE production is permanently custom-planned —
 *     becomes wrong too.
 *
 * None of that would fail anything today. The route would just get slower and
 * the closed analysis would quietly become false. This test is the signal.
 *
 * Full three-arm measurement (production path / `PREPARE` positive control /
 * no-`EXPLAIN` control), including the transaction trap handled below:
 * PEN-5613 document `promotion-premise-measurement`.
 */

/**
 * ⚠️ LOAD-BEARING NUMBER — do not lower it.
 *
 * Postgres's `choose_custom_plan` promotion threshold is 5: a named prepared
 * statement is custom-planned for its first five executions and only then
 * considered for a generic plan. At N <= 5 this test passes even on a driver
 * that DOES name statements, because promotion has not fired yet — the
 * assertion would be vacuous and the regression it exists to catch would sail
 * past it. N must exceed 5; 8 leaves headroom and matches PEN-5613's arms.
 */
const EXECUTIONS = 8;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres statement-naming tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("byProject never names a server-side prepared statement (PEN-5653)", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-stmt-naming-");
    /**
     * Pinned to a single pooled connection on purpose. `pg_prepared_statements`
     * is SESSION-scoped: it reports only what the reading connection prepared.
     * On the default pool the count could land on a connection that never ran
     * the queries and read 0 for the wrong reason — a probe that cannot fail,
     * which is exactly the error class PEN-5613 exists to document.
     *
     * This is still the real production handle: `createDb` builds it the same
     * way (`postgres(url, …)` -> `drizzlePg(sql, { schema })`), only with
     * `max = 1`. A hand-built `postgres()` client here would test a path
     * `byProject` does not take and the assertion would mean nothing.
     *
     * The negative control recorded on PEN-5653 is what proves the pinning
     * works: an explicit SQL `PREPARE` on this handle IS visible to the count
     * below, so a 0 here is a measurement rather than an artifact.
     */
    db = createDb(tempDb.connectionString, 1);
    costs = costService(db);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it(`leaves pg_prepared_statements empty after ${EXECUTIONS} executions`, async () => {
    const range = {
      from: new Date("2026-10-01T00:00:00.000Z"),
      to: new Date("2026-11-01T00:00:00.000Z"),
    };

    /**
     * Clear what the DRIVER prepared while setting the connection up, so the
     * count below measures only what the application queries added.
     *
     * Found by this test, and NOT in PEN-5613's trap list: postgres.js issues
     * its own array-type OID discovery query (`fetch_types`, a `pg_catalog`
     * join over `typcategory = 'A'`) as a tagged template on connect, so it IS
     * named and cached. PEN-5613's bench never saw it because its fixture
     * schema was a single table with no array columns; the real schema has
     * them, which is precisely why that row insisted on the real `db` handle.
     *
     * It is the same class as the `commit` entry PEN-5613 did find:
     * parameterless, issued by the driver rather than by application code,
     * with exactly one possible plan, and therefore outside plan promotion —
     * `choose_custom_plan` only ever chooses between a custom and a generic
     * plan for a statement that HAS bound parameters.
     *
     * Deallocating it up front keeps the assertion at an unambiguous 0 rather
     * than relaxing it to "<= 1" to absorb a known entry. A tolerance would
     * absorb a real regression too; this does not, because `byProject`'s
     * statement is prepared after this line, not before it. It is cached in
     * client state for the life of the connection, so it is not re-prepared.
     */
    await db.execute(sql.raw("DEALLOCATE ALL"));

    /**
     * Executed OUTSIDE a transaction, deliberately.
     *
     * PEN-5613 found that `sql.begin()` makes postgres.js issue its own
     * `commit` as a tagged template, which IS cached — so a naive count taken
     * after a transaction reads 1 and looks like a failure. That entry is
     * parameterless with exactly one possible plan and is irrelevant to plan
     * promotion. The fix is to assert outside a transaction, where the
     * expected count is unambiguously 0 — NOT to weaken this to `<= 1`, which
     * would also absorb a real regression.
     *
     * `byProject` takes no transaction of its own, so this is also the
     * production shape.
     */
    for (let i = 0; i < EXECUTIONS; i += 1) {
      await costs.byProject(companyId, range);
    }

    const prepared = (await db.execute(
      sql.raw("SELECT name, statement FROM pg_prepared_statements"),
    )) as unknown as { name: string; statement: string }[];

    expect(
      prepared,
      [
        `Expected pg_prepared_statements to be empty after ${EXECUTIONS} executions of byProject, found ${prepared.length}:`,
        ...prepared.map((row) => `  ${row.name}: ${row.statement}`),
        "",
        "A NAMED prepared statement here means the postgres-js driver has stopped forcing",
        "`prepare: false` — most likely a `drizzle-orm` or `postgres` bump, or a driver that",
        "now honours `.prepare(name)`. That reopens Postgres plan-cache promotion on this",
        "query: at execution #6 `choose_custom_plan` swaps the custom plan for a generic one",
        "measured ~1.7x SLOWER on `costs/by-project`, and that generic plan is immune to every",
        "index and statistics fix. The route gets slower with nothing else failing.",
        "",
        "It also rots two closed analyses, which need re-deciding rather than just re-greening:",
        "  - PEN-5613 closed as a negative on the premise that production CANNOT promote this",
        "    statement. If this test is red, that premise is false and the verdict is wrong.",
        "  - PEN-5643 holds that `CREATE STATISTICS` on `issues((id::text))` is a standalone",
        "    ~1.80x lever precisely BECAUSE production is permanently custom-planned. Under a",
        "    generic plan that figure collapses to the 1.01x PEN-5606 measured.",
        "",
        "Do not silence this by lowering EXECUTIONS below 6 or relaxing the count — see the",
        "comments above. Re-open PEN-5613 and PEN-5643 instead.",
      ].join("\n"),
    ).toEqual([]);
  });
});
