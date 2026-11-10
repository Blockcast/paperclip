import { describe, expect, it } from "vitest";
import { approvalService } from "../services/approvals.js";

/**
 * Service half of PEN-6425.
 *
 * The route suite pins that `{ limit, offset }` reaches the service. That is
 * necessary and not sufficient: delete `.limit(limit)` inside the service and
 * every route arm stays green while the response is the whole corpus again —
 * the original defect, with a passing suite over it. These arms mutate on the
 * service instead, by recording the statement the builder was asked to compose.
 *
 * They also pin the ORDER BY as two columns. `created_at` alone is not a total
 * order (two cards filed in the same millisecond may come back either way
 * round), and offset paging over a non-total order duplicates one row and drops
 * another across the page boundary. The `id` tiebreaker is what makes the
 * window well defined, and it is invisible to any test that only counts rows.
 */

function recordingDb() {
  const calls: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    from: () => chain,
    where: () => chain,
    orderBy: (...cols: unknown[]) => {
      calls.push(["orderBy", cols.length]);
      return chain;
    },
    limit: (n: number) => {
      calls.push(["limit", n]);
      return chain;
    },
    offset: (n: number) => {
      calls.push(["offset", n]);
      return chain;
    },
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
  });
  return {
    calls,
    db: { select: () => chain } as never,
  };
}

const COMPANY = "company-1";

describe("approvalService list paging (PEN-6425)", () => {
  it("applies limit and offset to the full view", async () => {
    const { calls, db } = recordingDb();
    await approvalService(db).list(COMPANY, {}, { limit: 3, offset: 10 });

    expect(calls).toContainEqual(["limit", 3]);
    expect(calls).toContainEqual(["offset", 10]);
  });

  it("applies limit and offset to the summary view", async () => {
    const { calls, db } = recordingDb();
    await approvalService(db).listSummary(COMPANY, {}, { limit: 5, offset: 2 });

    expect(calls).toContainEqual(["limit", 5]);
    expect(calls).toContainEqual(["offset", 2]);
  });

  it.each([
    ["full", async (svc: ReturnType<typeof approvalService>) => svc.list(COMPANY, {}, {})],
    ["summary", async (svc: ReturnType<typeof approvalService>) => svc.listSummary(COMPANY, {}, {})],
  ])("composes no window on the %s view when none is asked for", async (_name, run) => {
    const { calls, db } = recordingDb();
    await run(approvalService(db));

    expect(calls.map(([verb]) => verb)).not.toContain("limit");
    expect(calls.map(([verb]) => verb)).not.toContain("offset");
  });

  it("applies limit alone without an offset", async () => {
    const { calls, db } = recordingDb();
    await approvalService(db).listSummary(COMPANY, {}, { limit: 4 });

    expect(calls).toContainEqual(["limit", 4]);
    expect(calls.map(([verb]) => verb)).not.toContain("offset");
  });

  it.each([
    ["full", async (svc: ReturnType<typeof approvalService>) => svc.list(COMPANY, {}, {})],
    ["summary", async (svc: ReturnType<typeof approvalService>) => svc.listSummary(COMPANY, {}, {})],
  ])("orders the %s view by two columns so offset paging is total", async (_name, run) => {
    const { calls, db } = recordingDb();
    await run(approvalService(db));

    expect(calls).toContainEqual(["orderBy", 2]);
  });

  /**
   * `countBy` answers over every matching row by construction. Paging lives in
   * its own argument precisely so a window cannot reach it by accident: a count
   * that honoured `limit` would report a page size as a population, which is the
   * same confident-wrong-answer class this change removes.
   */
  it("never composes a window for countBy", async () => {
    const { calls, db } = recordingDb();
    await approvalService(db).countBy(COMPANY, {});

    expect(calls.map(([verb]) => verb)).not.toContain("limit");
    expect(calls.map(([verb]) => verb)).not.toContain("offset");
  });
});
