import { describe, expect, it, vi } from "vitest";
import { heartbeatRuns } from "@paperclipai/db";
import { buildPaperclipWorkspaceContext } from "../services/heartbeat.js";
import {
  SHARED_CHECKOUT_WARNING_RUN_SAMPLE,
  describeSharedCheckoutOccupancy,
  formatSharedCheckoutOccupancyWarning,
  listSiblingRunningRunIds,
} from "../services/shared-checkout-occupancy.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const SELF_RUN = "11111111-1111-1111-1111-111111111111";
const SIBLING_RUN = "22222222-2222-2222-2222-222222222222";

const CWD = "/paperclip/instances/default/workspaces/bbbbbbbb";

/**
 * Minimal drizzle-shaped stub: db.select().from().where() resolves to rows.
 *
 * It also CAPTURES the table handed to `from()` and the predicate handed to
 * `where()`. That capture is the point: a stub cannot evaluate `eq`/`ne`, so a
 * test that only counts `where` calls asserts nothing about the query and
 * survives deleting any filter in it. See the predicate test below.
 */
function selectStub(rows: Array<{ id: string }> | (() => never)) {
  const where = vi.fn(async (_predicate?: unknown) => {
    if (typeof rows === "function") rows();
    return rows as Array<{ id: string }>;
  });
  const from = vi.fn((_table?: unknown) => ({ where }));
  return { db: { select: vi.fn(() => ({ from })) } as never, where, from };
}

/**
 * Walk a drizzle `SQL` object and pull out the column names and comparison
 * operators it actually references, in order. Drizzle builds `and(eq(...))`
 * into a `queryChunks` array of alternating Column objects and raw SQL
 * fragments, so this reads the real predicate rather than a description of it.
 */
function readPredicate(predicate: unknown): { columns: string[]; operators: string[] } {
  const columns: string[] = [];
  const operators: string[] = [];
  (function walk(node: unknown): void {
    if (typeof node === "string") {
      const op = node.trim();
      if (op === "=" || op === "<>") operators.push(op);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && record.table) {
      columns.push(record.name);
      return;
    }
    if (Array.isArray(record.queryChunks)) record.queryChunks.forEach(walk);
    // Drizzle wraps raw SQL fragments in a StringChunk whose `value` is an
    // array of strings; the operators live there, not in queryChunks directly.
    if (Array.isArray(record.value)) record.value.forEach(walk);
  })(predicate);
  return { columns, operators };
}

describe("formatSharedCheckoutOccupancyWarning", () => {
  it("returns null when no sibling run is live", () => {
    expect(
      formatSharedCheckoutOccupancyWarning({
        cwd: CWD,
        strategyType: "project_primary",
        siblingRunIds: [],
      }),
    ).toBeNull();
  });

  it("names the sibling run, the strategy, and the shared cwd", () => {
    const warning = formatSharedCheckoutOccupancyWarning({
      cwd: CWD,
      strategyType: "project_primary",
      siblingRunIds: [SIBLING_RUN],
    });
    expect(warning).toContain("SHARED CHECKOUT CONTENTION");
    expect(warning).toContain(SIBLING_RUN);
    expect(warning).toContain("strategy=project_primary");
    expect(warning).toContain(`cwd=${CWD}`);
    // Singular when exactly one sibling -- the message is read by an agent.
    expect(warning).toContain("1 other live run of this agent");
  });

  it("admits the signal is agent-scoped rather than proven per-path", () => {
    const warning = formatSharedCheckoutOccupancyWarning({
      cwd: CWD,
      strategyType: "project_primary",
      siblingRunIds: [SIBLING_RUN],
    });
    // The count deliberately over-reports; the text must not imply certainty
    // that the sibling shares this exact directory.
    expect(warning).toContain("agent-scoped, not path-proven");
  });

  it("truncates the run list instead of pasting an unbounded fleet of ids", () => {
    const ids = Array.from(
      { length: SHARED_CHECKOUT_WARNING_RUN_SAMPLE + 3 },
      (_, index) => `run-${index}`,
    );
    const warning = formatSharedCheckoutOccupancyWarning({
      cwd: CWD,
      strategyType: "project_primary",
      siblingRunIds: ids,
    });
    expect(warning).toContain(`${ids.length} other live runs of this agent`);
    expect(warning).toContain("+3 more");
    expect(warning).not.toContain(`run-${SHARED_CHECKOUT_WARNING_RUN_SAMPLE}`);
  });
});

describe("listSiblingRunningRunIds", () => {
  it("returns sibling ids sorted", async () => {
    const { db, where } = selectStub([{ id: SIBLING_RUN }, { id: "00000000-aaaa" }]);
    const ids = await listSiblingRunningRunIds(db, {
      companyId: COMPANY,
      agentId: AGENT,
      selfRunId: SELF_RUN,
    });
    expect(ids).toEqual(["00000000-aaaa", SIBLING_RUN]);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("scopes the query to this agent's running runs on the heartbeat_runs table", async () => {
    // Pins every filter in the `and(...)`. Deleting the agentId filter makes
    // every running run company-wide count as contention, so the warning fires
    // universally and becomes noise -- exactly what the self-exclusion comment
    // argues must not happen. Asserting only `where` call-count would not
    // notice. Same for dropping the status filter (terminal runs counted as
    // live), swapping the table, or turning the self-exclusion `ne` into `eq`.
    const { db, where, from } = selectStub([]);
    await listSiblingRunningRunIds(db, {
      companyId: COMPANY,
      agentId: AGENT,
      selfRunId: SELF_RUN,
    });
    expect(from).toHaveBeenCalledWith(heartbeatRuns);
    const { columns, operators } = readPredicate(where.mock.calls[0]?.[0]);
    expect(columns).toEqual(["company_id", "agent_id", "status", "id"]);
    expect(operators).toEqual(["=", "=", "=", "<>"]);
  });

  it("excludes the caller's own run even when the query returns it", async () => {
    // Self-exclusion is the load-bearing property: without it every run counts
    // itself as contention and the warning fires universally. Assert it against
    // rows rather than trusting the SQL predicate -- a stub cannot evaluate
    // `ne()`, so testing it only through the query would be true by
    // construction and would survive deleting the guard.
    const { db } = selectStub([{ id: SELF_RUN }, { id: SIBLING_RUN }]);
    const ids = await listSiblingRunningRunIds(db, {
      companyId: COMPANY,
      agentId: AGENT,
      selfRunId: SELF_RUN,
    });
    expect(ids).toEqual([SIBLING_RUN]);
  });

  it("reports no contention when the caller is the only live run", async () => {
    const { db } = selectStub([{ id: SELF_RUN }]);
    await expect(
      listSiblingRunningRunIds(db, {
        companyId: COMPANY,
        agentId: AGENT,
        selfRunId: SELF_RUN,
      }),
    ).resolves.toEqual([]);
  });
});

describe("describeSharedCheckoutOccupancy", () => {
  const base = {
    companyId: COMPANY,
    agentId: AGENT,
    heartbeatRunId: SELF_RUN,
    cwd: CWD,
    strategyType: "project_primary",
  };

  it("warns when a sibling run is live", async () => {
    const { db } = selectStub([{ id: SIBLING_RUN }]);
    await expect(describeSharedCheckoutOccupancy({ ...base, db })).resolves.toContain(
      SIBLING_RUN,
    );
  });

  it("stays silent when this run is the only one", async () => {
    const { db } = selectStub([]);
    await expect(describeSharedCheckoutOccupancy({ ...base, db })).resolves.toBeNull();
  });

  it.each([
    ["no db", { db: null }],
    ["no agent identity", { agentId: null }],
    ["no run id of our own", { heartbeatRunId: null }],
  ])("stays silent with %s rather than counting itself as contention", async (_label, patch) => {
    const { db } = selectStub([{ id: SIBLING_RUN }]);
    await expect(
      describeSharedCheckoutOccupancy({ ...base, db, ...patch } as never),
    ).resolves.toBeNull();
  });

  it("never throws out of the workspace-realization hot path", async () => {
    const { db } = selectStub(() => {
      throw new Error("connection terminated");
    });
    await expect(describeSharedCheckoutOccupancy({ ...base, db })).resolves.toBeNull();
  });
});

/**
 * The delivery path. These exist because the first cut of BLO-27858 produced a
 * correct warning that no agent ever received: it was drained to the run log
 * only, while the code comments asserted it reached `context.paperclipWorkspace`
 * before the agent started. Every unit test passed. The gap was that none of
 * them checked the warning was observable where the code claimed to put it.
 */
describe("buildPaperclipWorkspaceContext", () => {
  const executionWorkspace = {
    cwd: CWD,
    source: "project_primary",
    strategy: "project_primary",
    projectId: null,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    branchName: null,
    worktreePath: null,
  };
  const build = (warnings: string[]) =>
    buildPaperclipWorkspaceContext({
      executionWorkspace,
      mode: "shared_workspace",
      warnings,
      realization: null,
      agentHome: "/home/agent",
    });

  it("delivers the contention warning to the agent's own context", () => {
    const warning = formatSharedCheckoutOccupancyWarning({
      cwd: CWD,
      strategyType: "project_primary",
      siblingRunIds: [SIBLING_RUN],
    });
    expect(warning).not.toBeNull();
    // The destination the module docs name. Drop `warnings` from the context
    // and this fails -- which is the regression that shipped last time.
    expect(build([warning as string]).warnings.join("\n")).toContain(SIBLING_RUN);
  });

  it("binds warnings by reference so entries added after the call still arrive", () => {
    // Callers keep pushing onto this array after the context is built (session
    // compaction, reuse-freshness), and the run-log drain reads it later still.
    // Copying here would drop everything appended after this point.
    const warnings: string[] = [];
    const context = build(warnings);
    warnings.push("added after the context was built");
    expect(context.warnings).toEqual(["added after the context was built"]);
  });

  it("survives the shallow spread the adapter context is built with", () => {
    const warnings = ["contention"];
    const context = build(warnings);
    // heartbeat.ts does `const adapterContext = { ...context }` before handing
    // it to the adapter; a shallow copy must still reach the same array.
    const adapterContext = { ...{ paperclipWorkspace: context } };
    warnings.push("late");
    expect(adapterContext.paperclipWorkspace.warnings).toEqual(["contention", "late"]);
  });
});
