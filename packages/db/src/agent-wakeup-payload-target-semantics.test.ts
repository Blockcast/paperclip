/**
 * PEN-6104: `agent_wakeup_requests.payload` is read two different ways in-tree,
 * and the difference is load-bearing.
 *
 *   MEMBERSHIP  `wakeRequestTargetsIssue` -- a four-arm DISJUNCTION. "Does this
 *               wake target issue X?" Serves the wake-diagnostics route and the
 *               heartbeat / recovery / watchdog / handoff reads.
 *   ATTRIBUTION `coalesce(payload ->> 'issueId', …)` -- "which SINGLE issue does
 *               this wake belong to?" Serves the blocked inbox and the subtree
 *               view, which each count a wake against exactly one row.
 *
 * They are NOT interchangeable, and PEN-6104's candidate 3 proposed persisting
 * the `coalesce` as a generated column and indexing it to serve the MEMBERSHIP
 * query. This file is the control on that: it pins, in CI, that the
 * substitution loses rows, so nobody can make it on the strength of the two
 * expressions looking equivalent.
 *
 * ⭐ WHY A TEST AND NOT JUST THE BENCH. `agent-wakeup-payload-index-shape.bench.ts`
 * demonstrates the same divergence, but `.bench.ts` is outside the test glob and
 * CI never runs it. A fact that only a hand-run file establishes is not a guard.
 *
 * ⚠️ The divergent row this builds is NOT reachable from any CURRENT writer --
 * every one of them sets all four keys from the same resolved `issueId` (the
 * deferred writer in `heartbeat.ts` builds the top level and the nested context
 * from one variable; both promotion paths `delete` the nested context first).
 * That is a property of today's code, not a constraint on the column: nothing in
 * the schema forbids the shape, the four arms exist because historical payloads
 * varied, and the stored `jsonb` is years deep. So this asserts what the
 * EXPRESSIONS do, which is the thing a future index would be built on.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
/** Named in the payload's TOP level. */
const TOP_LEVEL_ISSUE = "33333333-3333-4333-8333-333333333333";
/** Named ONLY inside `_paperclipWakeContext`. */
const NESTED_ISSUE = "44444444-4444-4444-8444-444444444444";

/** `services/issues.ts` `wakeRequestTargetsIssue`, verbatim in shape. */
const MEMBERSHIP = `
  payload ->> 'issueId' = $1
  or payload ->> 'taskId' = $1
  or payload -> '_paperclipWakeContext' ->> 'issueId' = $1
  or payload -> '_paperclipWakeContext' ->> 'taskId' = $1`;

/** The blocked-inbox / subtree expression, and candidate 3's column definition. */
const ATTRIBUTION = `
  coalesce(
    payload ->> 'issueId',
    payload ->> 'taskId',
    payload -> '_paperclipWakeContext' ->> 'issueId',
    payload -> '_paperclipWakeContext' ->> 'taskId') = $1`;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

async function seeded() {
  const database = await startEmbeddedPostgresTestDatabase("pen-6104-target-semantics");
  cleanups.push(async () => database.cleanup());
  const sql = postgres(database.connectionString, { max: 1 });
  cleanups.push(async () => void (await sql.end()));

  await sql`insert into companies (id, name) values (${COMPANY}, 'pen-6104') on conflict do nothing`;
  await sql`
    insert into agents (id, company_id, name, role)
    values (${AGENT}, ${COMPANY}, 'pen-6104-agent', 'engineer')
    on conflict do nothing`;
  // The divergent row: top level names one issue, nested context names another.
  await sql`
    insert into agent_wakeup_requests (company_id, agent_id, source, reason, payload, status)
    values (
      ${COMPANY}, ${AGENT}, 'issue', 'issue_execution_deferred',
      ${sql.json({
        issueId: TOP_LEVEL_ISSUE,
        _paperclipWakeContext: { issueId: NESTED_ISSUE, taskId: NESTED_ISSUE },
      })},
      'deferred_issue_execution')`;
  return sql;
}

const count = async (sql: postgres.Sql, predicate: string, issueId: string) => {
  const rows = await sql.unsafe(
    `select count(*)::int as n from agent_wakeup_requests where company_id = $2 and (${predicate})`,
    [issueId, COMPANY] as never[],
  );
  return (rows as unknown as { n: number }[])[0].n;
};

describeEmbeddedPostgres("PEN-6104 wake payload target expressions", () => {
  it("membership finds the wake under BOTH issues it names; attribution finds it under only one", async () => {
    const sql = await seeded();

    // Membership: the row genuinely targets both, and both must be findable --
    // this is the property the wake-diagnostics route depends on.
    expect(await count(sql, MEMBERSHIP, TOP_LEVEL_ISSUE)).toBe(1);
    expect(await count(sql, MEMBERSHIP, NESTED_ISSUE)).toBe(1);

    // Attribution: `coalesce` takes the FIRST non-null key, so the row is
    // attributed to the top level only. Correct for a one-row-per-wake count;
    // wrong as a membership test.
    expect(await count(sql, ATTRIBUTION, TOP_LEVEL_ISSUE)).toBe(1);
    expect(await count(sql, ATTRIBUTION, NESTED_ISSUE)).toBe(0);
  }, 180_000);

  it("⛔ a coalesce-defined generated column cannot serve the membership query", async () => {
    const sql = await seeded();

    // Candidate 3 exactly: persist the attribution expression, index it, and
    // point the membership reads at it.
    await sql.unsafe(`
      alter table agent_wakeup_requests add column target_issue_id text
        generated always as (coalesce(
          payload ->> 'issueId',
          payload ->> 'taskId',
          payload -> '_paperclipWakeContext' ->> 'issueId',
          payload -> '_paperclipWakeContext' ->> 'taskId')) stored`);

    expect(await count(sql, "target_issue_id = $1", TOP_LEVEL_ISSUE)).toBe(1);
    // The silent drop. The row IS wake history for the nested issue, and the
    // route would report the issue as having no wakes at all.
    expect(await count(sql, "target_issue_id = $1", NESTED_ISSUE)).toBe(0);

    // ⭐ The array form models membership exactly, at one object, and is what
    // the bench measures as the cheapest exact single-column shape.
    await sql.unsafe(`
      alter table agent_wakeup_requests add column target_issue_ids text[]
        generated always as (array[
          payload ->> 'issueId',
          payload ->> 'taskId',
          payload -> '_paperclipWakeContext' ->> 'issueId',
          payload -> '_paperclipWakeContext' ->> 'taskId']) stored`);

    expect(await count(sql, "target_issue_ids && array[$1::text]", TOP_LEVEL_ISSUE)).toBe(1);
    expect(await count(sql, "target_issue_ids && array[$1::text]", NESTED_ISSUE)).toBe(1);
  }, 180_000);

  it("the partial-index guard PEN-6104 candidate 2 needs is logically equivalent to the plain arm", async () => {
    const sql = await seeded();

    // `payload ->> 'issueId' = $1` cannot USE a `where payload ? 'issueId'`
    // partial index, because the planner cannot prove the implication. Each arm
    // therefore has to state the guard itself -- which must not change the
    // answer. If this ever diverges, the rewrite is not safe to ship.
    const guarded = `
      (payload ? 'issueId' and payload ->> 'issueId' = $1)
      or (payload ? 'taskId' and payload ->> 'taskId' = $1)
      or (payload -> '_paperclipWakeContext' ? 'issueId'
          and payload -> '_paperclipWakeContext' ->> 'issueId' = $1)
      or (payload -> '_paperclipWakeContext' ? 'taskId'
          and payload -> '_paperclipWakeContext' ->> 'taskId' = $1)`;

    for (const issueId of [TOP_LEVEL_ISSUE, NESTED_ISSUE, COMPANY /* matches nothing */]) {
      expect(await count(sql, guarded, issueId)).toBe(await count(sql, MEMBERSHIP, issueId));
    }

    // And it holds for a payload carrying no issue keys at all -- the ~55% of
    // rows the timer writes, where every `->>` is NULL and every `?` is false.
    await sql`
      insert into agent_wakeup_requests (company_id, agent_id, source, reason, payload, status)
      values (${COMPANY}, ${AGENT}, 'timer', 'heartbeat_tick', ${sql.json({ source: "timer" })}, 'completed')`;
    expect(await count(sql, guarded, TOP_LEVEL_ISSUE)).toBe(await count(sql, MEMBERSHIP, TOP_LEVEL_ISSUE));
  }, 180_000);
});
