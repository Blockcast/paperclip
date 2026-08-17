import { describe, expect, it, vi } from "vitest";
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

/** Minimal drizzle-shaped stub: db.select().from().where() resolves to rows. */
function selectStub(rows: Array<{ id: string }> | (() => never)) {
  const where = vi.fn(async () => {
    if (typeof rows === "function") rows();
    return rows as Array<{ id: string }>;
  });
  const from = vi.fn(() => ({ where }));
  return { db: { select: vi.fn(() => ({ from })) } as never, where };
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
