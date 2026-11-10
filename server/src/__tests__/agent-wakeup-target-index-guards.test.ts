/**
 * PEN-6104: the four `?` key-existence guards in
 * `services/agent-wakeup-target.ts` are what make migration 0278's four
 * partial indexes reachable, and nothing pinned them to the SHIPPED HELPER.
 *
 * `packages/db/src/agent-wakeup-payload-target-index.test.ts` already pins
 * both halves of the property against a live Postgres — that the guarded
 * disjunction selects the same rows as the plain one, and that only the
 * guarded form probes the indexes. But it RESTATES the predicate as a string
 * literal, because `packages/db` must not depend on `server`. So deleting a
 * guard from the helper leaves that file green: it goes on testing the
 * literal, which still carries the guard, while every one of the five
 * production readers has silently reverted to the full-walk plan. The
 * reachability finding is intact and simply no longer about the shipped code.
 *
 * This file closes that by RENDERING the helper and asserting the guards are
 * in what it emits. It lives in `server` precisely because the package
 * boundary that forced the restatement does not run this way.
 *
 * ⛔ It deliberately asserts SQL TEXT rather than behaviour. There is no
 * behavioural difference to assert — the guards are semantically redundant
 * (a non-NULL `->>` implies the key exists), which is exactly why they get
 * deleted as dead weight. The plan is the only thing they change, and the
 * plan needs a populated Postgres, which is the sibling's job. Text is the
 * cheap half; it is not the whole guard, and it is not meant to be.
 */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  wakeRequestTargetsAnyIssueCondition,
  wakeRequestTargetsIssueCondition,
} from "../services/agent-wakeup-target.js";

const dialect = new PgDialect();
const render = (query: Parameters<typeof dialect.sqlToQuery>[0]) => dialect.sqlToQuery(query).sql;

/** The four arms of the membership disjunction, and 0278's four indexes. */
const GUARDS = [
  `"payload" ? 'issueId'`,
  `"payload" ? 'taskId'`,
  `"payload" -> '_paperclipWakeContext' ? 'issueId'`,
  `"payload" -> '_paperclipWakeContext' ? 'taskId'`,
] as const;

describe("wake-target predicates keep the guards that reach migration 0278", () => {
  it("emits all four `?` guards for the single-issue condition", () => {
    const sql = render(wakeRequestTargetsIssueCondition("33333333-3333-4333-8333-333333333333"));
    for (const guard of GUARDS) {
      expect(sql, `single-issue predicate dropped the guard \`${guard}\``).toContain(guard);
    }
  });

  it("emits all four `?` guards for the subtree condition", () => {
    const sql = render(
      wakeRequestTargetsAnyIssueCondition([
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ]),
    );
    for (const guard of GUARDS) {
      expect(sql, `subtree predicate dropped the guard \`${guard}\``).toContain(guard);
    }
  });

  it("pairs every guard with the `->>` arm it guards, in that order", () => {
    // Containment alone would pass on a predicate that has drifted into
    // `(payload ->> 'issueId' = $1) or (payload ? 'issueId' and ...)` — the
    // guard present, the arm it is supposed to gate not actually gated. A
    // partial index is reachable only where the planner can prove the query
    // implies the index predicate, so the pairing is the property, not the
    // presence.
    const sql = render(wakeRequestTargetsIssueCondition("33333333-3333-4333-8333-333333333333"));
    const arms: Array<[guard: string, accessor: string]> = [
      [`"payload" ? 'issueId'`, `"payload" ->> 'issueId'`],
      [`"payload" ? 'taskId'`, `"payload" ->> 'taskId'`],
      [
        `"payload" -> '_paperclipWakeContext' ? 'issueId'`,
        `"payload" -> '_paperclipWakeContext' ->> 'issueId'`,
      ],
      [
        `"payload" -> '_paperclipWakeContext' ? 'taskId'`,
        `"payload" -> '_paperclipWakeContext' ->> 'taskId'`,
      ],
    ];
    for (const [guard, accessor] of arms) {
      const guardAt = sql.indexOf(guard);
      const accessorAt = sql.indexOf(accessor);
      expect(guardAt, `missing guard \`${guard}\``).toBeGreaterThanOrEqual(0);
      expect(accessorAt, `missing arm \`${accessor}\``).toBeGreaterThanOrEqual(0);
      expect(
        guardAt,
        `\`${accessor}\` is not gated by its \`?\` guard; it cannot reach the partial index`,
      ).toBeLessThan(accessorAt);
    }
  });

  it("fails if an arm is added without a guard", () => {
    // Non-vacuity. The assertions above are containment and ordering, both of
    // which a SHRINKING predicate satisfies more easily — so pin the arm count
    // too. Four arms, four guards, four indexes, one-to-one; a fifth arm with
    // no guard is a full walk the other three assertions would not see.
    const sql = render(wakeRequestTargetsIssueCondition("33333333-3333-4333-8333-333333333333"));
    expect([...sql.matchAll(/->>/g)]).toHaveLength(4);
    expect([...sql.matchAll(/\?\s+'/g)]).toHaveLength(4);
  });
});
