/**
 * PEN-6056: migration 0279's folded-key index must back the case-insensitive
 * arm of the artifact -> owning row lookup.
 *
 * `work-products/by-external-id` used to match `owner/repo#123` byte-exactly.
 * GitHub is case-insensitive on BOTH segments, the stored key is whatever casing
 * the webhook received, and the caller has no way to know it -- so
 * `blockcast/penstock-llm-proxy-core#3055` returned `owners: []` with
 * `withheldForAuthorizationCount: 0`, byte-identical to a genuinely unowned pull
 * request. `listOwnersByExternalId` now compares `lower(external_id)` against a
 * pre-folded constant, and migration 0035's index CANNOT serve that: it indexes
 * the RAW column, so the folded predicate is not an index condition.
 *
 * THE SECOND TEST IS THE ONE WITH TEETH, and it pins a design decision that
 * would otherwise be invisible. The fold applies only to
 * `provider = 'github' and type = 'pull_request'`, which reads exactly like a
 * partial-index predicate -- and a partial index here would be WRONG in a way no
 * correctness test could see. The query binds provider and type as PARAMETERS,
 * and Postgres can only prove a partial index applicable against constants, so
 * the index would build, look correct in `\di`, and never be chosen. Both are
 * therefore ordinary leading columns, and the generic-plan probe below is what
 * proves it: `force_generic_plan` is the planner state a parameterised query
 * reaches, and under it the index must still be used.
 *
 * The probe mirrors `listOwnersByExternalId`
 * (server/src/services/work-products.ts) and deliberately omits its join to
 * `issues` -- the question here is this table's access path, and the join only
 * adds a second relation whose plan says nothing about the index under test.
 * Re-check that service when this file changes; the fold lives in
 * `workProductExternalIdMatchKey` and both sides must agree.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "issue_work_products_company_folded_external_id_idx";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";
/** Stored in GitHub's casing; every probe below asks in a different one. */
const STORED_KEY = "Blockcast/Penstock-LLM-Proxy-Core#3055";
const FOLDED_KEY = STORED_KEY.toLowerCase();

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

/**
 * A company with a long history of pull requests, plus a second company sharing
 * the table. One row carries the key under test, in a casing no probe uses.
 */
async function seed(sql: postgres.Sql) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO issue_work_products (company_id, issue_id, type, provider, external_id, title, status)
    SELECT CASE WHEN g % 4 = 0 THEN '${OTHER_COMPANY_ID}'::uuid ELSE '${COMPANY_ID}'::uuid END,
           '${ISSUE_ID}'::uuid,
           CASE WHEN g % 11 = 0 THEN 'branch' ELSE 'pull_request' END,
           'github',
           'Blockcast/Paperclip#' || g,
           'PR ' || g,
           'ready_for_review'
    FROM generate_series(1, 30000) AS g;
    INSERT INTO issue_work_products (company_id, issue_id, type, provider, external_id, title, status)
    VALUES ('${COMPANY_ID}', '${ISSUE_ID}', 'pull_request', 'github', '${STORED_KEY}', 'The row under test', 'ready_for_review');
    SET session_replication_role = origin;
    ANALYZE issue_work_products;
  `);
}

describeEmbeddedPostgres("issue_work_products folded external id index (migration 0279)", () => {
  it("is defined as (company_id, provider, type, lower(external_id)) and is not partial", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-iwp-folded-idx-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${INDEX_NAME}
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain(
      "ON public.issue_work_products USING btree (company_id, provider, type, lower(external_id))",
    );
    // Asserted as an absence because the WHERE is the trap, not a detail: a
    // partial index on provider/type would satisfy every correctness test in this
    // repo and still never be chosen for the parameterised query.
    expect(indexes[0]?.indexdef).not.toContain("WHERE");

    // Migration 0035's index stays: it still serves every byte-exact caller,
    // including the webhook's own `selectIssuesLinkedToPullRequest`.
    const exact = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'issue_work_products_company_provider_external_id_idx'
    `;
    expect(exact).toHaveLength(1);
  }, 120_000);

  it("serves the lookup from the index under a GENERIC plan, as the parameterised query gets", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-iwp-folded-plan-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    await seed(sql);

    await sql.unsafe(`
      PREPARE owner_lookup (uuid, text, text, text) AS
        SELECT id FROM issue_work_products
         WHERE company_id = $1 AND provider = $2 AND type = $3 AND lower(external_id) = $4;
      SET plan_cache_mode = force_generic_plan;
    `);

    const plan = (
      await sql.unsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN EXECUTE owner_lookup('${COMPANY_ID}', 'github', 'pull_request', '${FOLDED_KEY}')`,
      )
    )
      .map((row) => row["QUERY PLAN"])
      .join("\n");

    expect(plan).toContain(INDEX_NAME);
    expect(plan).not.toMatch(/Seq Scan on issue_work_products/);

    // The answer, not only the plan. The row is stored in a casing no probe uses,
    // so a predicate that lost the fold returns nothing -- which is precisely the
    // empty set this whole change exists to stop being returned.
    const found = await sql.unsafe<{ id: string }[]>(
      `EXECUTE owner_lookup('${COMPANY_ID}', 'github', 'pull_request', '${FOLDED_KEY}')`,
    );
    expect(found).toHaveLength(1);
  }, 120_000);
});
