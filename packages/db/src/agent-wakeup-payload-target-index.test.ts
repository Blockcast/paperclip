/**
 * PEN-6104: the four partial payload-target indexes (migration 0278) and the
 * GUARDED reader that is the only thing able to reach them.
 *
 * Two separate properties, and the second is the one that actually bit.
 *
 *   EQUIVALENCE  the guarded disjunction
 *                `(payload ? 'issueId' and payload ->> 'issueId' = $1) or …`
 *                selects exactly the rows the plain
 *                `payload ->> 'issueId' = $1 or …` selects. It has to: a
 *                non-NULL `->>` implies the key exists. But the rewrite touches
 *                five subsystems' read paths, so "has to" is not evidence.
 *
 *   REACHABILITY the guarded form PROBES the four indexes and the plain form
 *                DOES NOT. This is not a performance nicety — it is the whole
 *                migration. A partial index is usable only where the planner
 *                can prove the query implies the index predicate, and
 *                `payload ->> 'issueId' = $1` does not imply
 *                `payload ? 'issueId'` even though it entails it. Measured at
 *                2M rows in `agent-wakeup-payload-index-shape.bench.ts`: with
 *                the plain reader the four indexes are built, are 124 MB, and
 *                the plan never touches them — 253.8 ms, i.e. unchanged from
 *                having no index at all. With the guards, 0.2 ms.
 *
 * ⛔ So the failure mode this file exists to catch is NOT a wrong answer. It is
 * someone deleting a `?` guard as redundant — which it is, semantically — and
 * silently restoring a full walk of the company's window on the largest table
 * in the schema. An equivalence-only test goes green on that.
 *
 * ⚠️ `enable_seqscan = off` is set for the plan assertions and is doing LESS
 * than it looks. It is there because the seed is small; it does not force the
 * partial indexes, and it leaves `agent_wakeup_requests_company_requested_idx`
 * available — which is exactly the plan the unguarded form falls back to, and
 * what the negative assertion below observes it choosing. If this ever had to
 * force the specific indexes to see them used, the finding would be gone.
 *
 * Sibling of `agent-wakeup-payload-target-semantics.test.ts`, which pins the
 * MEMBERSHIP-vs-ATTRIBUTION divergence (why four objects and not one
 * `coalesce` column). That one is about the expressions; this one is about the
 * shipped indexes.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const TARGET = "33333333-3333-4333-8333-333333333333";
const NESTED_ONLY = "44444444-4444-4444-8444-444444444444";

const INDEX_NAMES = [
  "agent_wakeup_requests_payload_issue_idx",
  "agent_wakeup_requests_payload_task_idx",
  "agent_wakeup_requests_payload_context_issue_idx",
  "agent_wakeup_requests_payload_context_task_idx",
] as const;

/** The predicate every reader issued before PEN-6104. */
const PLAIN = `
  company_id = $1 and (
       payload ->> 'issueId' = $2
    or payload ->> 'taskId' = $2
    or payload -> '_paperclipWakeContext' ->> 'issueId' = $2
    or payload -> '_paperclipWakeContext' ->> 'taskId' = $2)`;

/**
 * What `wakeRequestTargetsIssueCondition` in
 * `server/src/services/agent-wakeup-target.ts` now emits. Restated here rather
 * than imported: `packages/db` must not depend on `server`, and the shape is
 * the thing under test.
 */
const GUARDED = `
  company_id = $1 and (
       (payload ? 'issueId' and payload ->> 'issueId' = $2)
    or (payload ? 'taskId' and payload ->> 'taskId' = $2)
    or (payload -> '_paperclipWakeContext' ? 'issueId'
        and payload -> '_paperclipWakeContext' ->> 'issueId' = $2)
    or (payload -> '_paperclipWakeContext' ? 'taskId'
        and payload -> '_paperclipWakeContext' ->> 'taskId' = $2))`;

const select = (predicate: string) =>
  `select id from agent_wakeup_requests where ${predicate} order by requested_at desc, created_at desc`;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// 120s, not the 60s its sibling uses: this file starts an embedded Postgres
// per test rather than per file, and a shutdown under a loaded CI runner has
// been seen past 60s. The failure that buys is a hook timeout on a passing
// test, which reads as a product failure and is not one.
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 120_000);

async function seeded() {
  const database = await startEmbeddedPostgresTestDatabase("pen-6104-target-index");
  cleanups.push(async () => database.cleanup());
  const sql = postgres(database.connectionString, { max: 1 });
  cleanups.push(async () => void (await sql.end()));

  await sql`insert into companies (id, name) values (${COMPANY}, 'pen-6104') on conflict do nothing`;
  await sql`
    insert into agents (id, company_id, name, role)
    values (${AGENT}, ${COMPANY}, 'pen-6104-agent', 'engineer')
    on conflict do nothing`;

  const payloads: postgres.JSONValue[] = [
    // Every arm, one row each, so a dropped guard shows up as a missing row
    // rather than as a coincidence of one payload satisfying several arms.
    { issueId: TARGET },
    { taskId: TARGET },
    { _paperclipWakeContext: { issueId: TARGET } },
    { _paperclipWakeContext: { taskId: TARGET } },
    // Divergent: attributed to one issue, a member of two.
    { issueId: NESTED_ONLY, _paperclipWakeContext: { issueId: TARGET } },
    // Non-members that still have to survive both forms identically.
    { issueId: NESTED_ONLY },
    { commentId: TARGET },
    {},
  ];
  for (const payload of payloads) {
    await sql`
      insert into agent_wakeup_requests (company_id, agent_id, source, reason, payload, status)
      values (${COMPANY}, ${AGENT}, 'issue', 'issue_comment_added', ${sql.json(payload)}, 'queued')`;
  }
  // Padding so the planner has something to prefer an index over. Deliberately
  // NOT targets: these are the rows a sparse lookup would otherwise walk.
  await sql.unsafe(`
    insert into agent_wakeup_requests (company_id, agent_id, source, reason, payload, status)
    select '${COMPANY}', '${AGENT}', 'timer', 'timer',
           jsonb_build_object('issueId', ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))),
           'queued'
    from generate_series(1, 2000) AS g`);
  await sql.unsafe("analyze agent_wakeup_requests");
  return sql;
}

async function planFor(sql: postgres.Sql, predicate: string): Promise<string> {
  const rows = await sql.unsafe(`explain ${select(predicate)}`, [COMPANY, TARGET] as never[]);
  return (rows as unknown as Record<string, string>[]).map((row) => row["QUERY PLAN"]).join("\n");
}

describeEmbeddedPostgres("PEN-6104 wake-payload target indexes", () => {
  it("creates all four indexes on a fresh database", async () => {
    const sql = await seeded();
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'agent_wakeup_requests'
        and indexname = any(${[...INDEX_NAMES]})
      order by indexname`;
    expect(rows.map((row) => row.indexname)).toEqual([...INDEX_NAMES].sort());
  }, 180_000);

  it("the guarded predicate selects exactly the rows the plain disjunction selects", async () => {
    const sql = await seeded();
    const plain = await sql.unsafe(select(PLAIN), [COMPANY, TARGET] as never[]);
    const guarded = await sql.unsafe(select(GUARDED), [COMPANY, TARGET] as never[]);
    const ids = (rows: unknown) => (rows as { id: string }[]).map((row) => row.id).sort();

    // Non-vacuity: an empty-vs-empty comparison would pass on a seed that
    // matched nothing, which is the one way this assertion can lie.
    expect(ids(plain)).toHaveLength(5);
    expect(ids(guarded)).toEqual(ids(plain));
  }, 180_000);

  it("only the guarded predicate can reach the partial indexes", async () => {
    const sql = await seeded();
    await sql.unsafe("set enable_seqscan = off");

    const guardedPlan = await planFor(sql, GUARDED);
    const plainPlan = await planFor(sql, PLAIN);

    // Every arm reaches its own index, so all four appear. Asserted per name:
    // a plan that probed three of four would still "contain an index scan".
    for (const name of INDEX_NAMES) {
      expect(guardedPlan, `guarded plan should probe ${name}:\n${guardedPlan}`).toContain(name);
    }

    // The finding, stated as an assertion. `payload ->> 'issueId' = $2` does
    // not imply `payload ? 'issueId'`, so the planner cannot prove the partial
    // indexes apply. It falls back to a company-scoped index with all four arms
    // as a per-row `Filter` over every row in the company — the pre-PEN-6104
    // plan, now with 124 MB of index sitting unused beside it. (Which company
    // index it picks depends on the rest of the predicate and is not the point;
    // that none of the four is probed is.)
    for (const name of INDEX_NAMES) {
      expect(plainPlan, `unguarded plan must NOT reach ${name}:\n${plainPlan}`).not.toContain(name);
    }
  }, 180_000);
});
