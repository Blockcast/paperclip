import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

/**
 * PEN-3895 item 1 (Ally suggestion on #2324, raised independently by two lenses).
 *
 * `owningAgentIdsByRunId` is the SOLE owner resolution feeding the run-transcript
 * gate on all three workspace-operation read routes. It resolved `heartbeat_runs`
 * by id alone, so the gate's correctness rested on every caller having scoped its
 * run ids beforehand rather than on the query.
 *
 * Not a live hole — ids arrive from company-scoped lookups and a foreign
 * `agentId` would fail both `allow_self` and `isManagerOf` — so what is pinned
 * here is the defence-in-depth property itself: the predicate reaches the SQL,
 * carrying the caller's company, and a cross-company run resolves to absent
 * rather than to an owner.
 *
 * Asserted against the rendered SQL rather than a stubbed result, because a fake
 * `db` returns whatever it is told to and would pass just as happily with the
 * predicate deleted — which is the regression this exists to catch.
 */

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../services/workspace-operation-log-store.js", () => ({
  getWorkspaceOperationLogStore: () => ({
    begin: async () => ({ store: "local_file", logRef: "test/log.ndjson" }),
    append: async () => undefined,
    finalize: async () => ({ bytes: 0, sha256: "sha", compressed: false }),
    read: async () => ({ content: "" }),
  }),
}));

const { workspaceOperationService } = await import("../services/workspace-operations.js");

let capturedWhere: SQL | null = null;

/** Captures the `where` clause and answers with whatever rows the test supplies. */
function makeFakeDb(rows: { id: string; agentId: string | null }[]) {
  return {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          capturedWhere = condition;
          return Promise.resolve(rows);
        },
      }),
    }),
  } as never;
}

function renderWhere() {
  expect(capturedWhere, "the query was never issued").not.toBeNull();
  return new PgDialect().sqlToQuery(capturedWhere as SQL);
}

describe("PEN-3895: workspace-operation owner resolution is company-scoped", () => {
  beforeEach(() => {
    capturedWhere = null;
  });

  it("filters heartbeat runs by the caller's company, not by run id alone", async () => {
    const svc = workspaceOperationService(makeFakeDb([{ id: "run-1", agentId: "agent-1" }]));

    await svc.owningAgentIdsByRunId(["run-1", "run-2"], "company-1");

    const { sql, params } = renderWhere();
    // The id restriction is still there...
    expect(sql).toContain('"id"');
    // ...AND the company predicate now is. Without it this is `inArray` alone.
    expect(sql).toContain('"company_id"');
    // ...and the two are ANDed: an `or(...)` would satisfy both presence checks above.
    expect(sql).not.toMatch(/\bor\b/i);
    expect(sql).toMatch(/\band\b/i);
    // The caller's company is what reaches the query, not a constant.
    expect(params).toContain("company-1");
    expect(params).toContain("run-1");
    expect(params).toContain("run-2");
  });

  it("resolves an owner for a run the company owns", async () => {
    const svc = workspaceOperationService(makeFakeDb([{ id: "run-1", agentId: "agent-1" }]));

    const owners = await svc.owningAgentIdsByRunId(["run-1"], "company-1");

    expect(owners.get("run-1")).toBe("agent-1");
  });

  it("leaves a run the predicate excluded absent, which callers already treat as withhold", async () => {
    // What the narrowed query returns for a foreign run: no row at all.
    const svc = workspaceOperationService(makeFakeDb([]));

    const owners = await svc.owningAgentIdsByRunId(["run-from-another-company"], "company-1");

    // Absent, not null and not a thrown error — the single fail-closed shape
    // this helper's contract already defines, so no new caller branch appears.
    expect(owners.has("run-from-another-company")).toBe(false);
    expect(owners.size).toBe(0);
  });

  it("issues no query at all when there is nothing to resolve", async () => {
    const svc = workspaceOperationService(makeFakeDb([]));

    const owners = await svc.owningAgentIdsByRunId([null, ""], "company-1");

    expect(owners.size).toBe(0);
    expect(capturedWhere).toBeNull();
  });
});
