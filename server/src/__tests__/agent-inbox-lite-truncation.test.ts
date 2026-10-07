import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISSUE_LIST_APPLIED_LIMIT_HEADER,
  ISSUE_LIST_TRUNCATED_HEADER,
} from "../lib/issue-list-query.js";
import { ISSUE_LIST_DEFAULT_LIMIT } from "../services/issues.js";
import { loadAgentInboxLite } from "../services/agent-inbox-lite.js";

// BLO-39015: `inbox-lite` is capped and ordered `priority` ASC, so on a lane
// deeper than the cap the cut lands mid-band and every row below it is
// unreachable — measured on one lane as 139 of 634 rows, including ALL 44
// `low`. It returned a bare array with no signal, so the page was
// indistinguishable from the population.
//
// The failure direction is the expensive one. A wrong POSITIVE gets tested by
// whoever acts on it; a silently-short page reads as "that is everything", and
// the rows it hides look perfectly healthy on every triage surface (`todo`,
// assigned, dependency-clear, recent `updatedAt`). Nothing downstream notices.
// It also falsified BLO-27553's disposition 2 — "leave it `todo`, `todo` keeps
// the row in inbox-lite and re-dispatchable" — which is the fleet-wide remedy
// for permanent strands, so complying with the strand rule created a different
// silent strand.

const mockIssueService = {
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
};
const mockRecoveryActionService = {
  listActiveForIssues: vi.fn(),
};

// The REST block below drives the real `routes/agents.ts` handler, so the two
// services it reaches for have to come back from the module graph rather than
// from a hand-passed argument. `loadAgentInboxLite` is imported directly from
// `../services/agent-inbox-lite.js` by both the route and this file, so it
// stays REAL under these mocks — which is the point: the probe, the filters and
// the header emission are all exercised as shipped.
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    issueService: () => mockIssueService,
    issueRecoveryActionService: () => mockRecoveryActionService,
  };
});

vi.mock("../services/instance-settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/instance-settings.js")>();
  return {
    ...actual,
    instanceSettingsService: () => ({ getExperimental: async () => ({}) }),
  };
});

type LoadInboxInput = Parameters<typeof loadAgentInboxLite>[0];

const inactiveWorktreeActivation: LoadInboxInput["worktreeActivation"] = {
  armed: false,
  cutoff: null,
  activationInstanceId: null,
  reason: "not_worktree_runtime",
};

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function row(id: string, priority: keyof typeof PRIORITY_RANK, updatedAt = "2026-09-30T00:00:00.000Z") {
  return {
    id,
    identifier: `BLO-${id}`,
    title: id,
    status: "todo",
    priority,
    projectId: null,
    goalId: null,
    parentId: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt,
    activeRun: null,
    monitorNextCheckAt: null,
    scheduledRetryAt: null,
    scheduledRetryReason: null,
    scheduledRetryAttempt: null,
    scheduledRetryParkedRuns: [],
  };
}

/**
 * The lane from the filing: deeper than the cap, with the `low` band entirely
 * below the waterline. Served through the same priority ordering the service
 * applies (`issueListOrderBy`: priority ASC, then recency), honouring
 * `limit`/`offset` so paging is exercised end to end rather than stubbed.
 */
function serveLane(population: ReturnType<typeof row>[]) {
  const ordered = [...population].sort(
    (a, b) =>
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  mockIssueService.list.mockImplementation(async (_companyId: string, filters: any) => {
    const offset = filters.offset ?? 0;
    return filters.limit === undefined
      ? ordered.slice(offset)
      : ordered.slice(offset, offset + filters.limit);
  });
  return ordered;
}

function loadInbox(options: Partial<LoadInboxInput> = {}) {
  return loadAgentInboxLite({
    issuesSvc: mockIssueService as unknown as LoadInboxInput["issuesSvc"],
    recoveryActionsSvc:
      mockRecoveryActionService as unknown as LoadInboxInput["recoveryActionsSvc"],
    companyId: "company-1",
    agentId: "agent-1",
    callerRunId: "run-1",
    limit: 10,
    isWorktreeRuntime: false,
    worktreeActivation: inactiveWorktreeActivation,
    ...options,
  });
}

describe("agent inbox-lite truncation signal (BLO-39015)", () => {
  // 12 rows against a limit of 10: the cut lands inside `medium` and both
  // `low` rows sit below it — the filed shape in miniature.
  const deepLane = [
    ...Array.from({ length: 2 }, (_, i) => row(`critical-${i}`, "critical")),
    ...Array.from({ length: 4 }, (_, i) => row(`high-${i}`, "high")),
    ...Array.from({ length: 4 }, (_, i) => row(`medium-${i}`, "medium")),
    ...Array.from({ length: 2 }, (_, i) => row(`low-${i}`, "low")),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  // Non-vacuity, per the filing's own verifying signal: on a lane under the cap
  // this defect is unobservable, so assert the lane IS deeper before concluding
  // anything from the truncated case below.
  it("reports a complete page as NOT truncated when the lane fits under the cap", async () => {
    serveLane(deepLane.slice(0, 7));

    const inbox = await loadInbox();

    expect(inbox.rows).toHaveLength(7);
    expect(inbox.truncated).toBe(false);
    expect(inbox.appliedLimit).toBe(10);
  });

  it("flags a capped page as truncated and still returns exactly `limit` rows", async () => {
    const ordered = serveLane(deepLane);
    expect(ordered.length).toBeGreaterThan(10); // non-vacuity

    const inbox = await loadInbox();

    expect(inbox.truncated).toBe(true);
    expect(inbox.rows).toHaveLength(10);
    expect(inbox.appliedLimit).toBe(10);
    // The defect, restated as an assertion: without paging, `low` is gone.
    expect(inbox.rows.map((r) => r.priority)).not.toContain("low");
  });

  it("over-fetches exactly one probe row rather than running a second count query", async () => {
    serveLane(deepLane);

    await loadInbox();

    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0]![1]).toMatchObject({ limit: 11, offset: 0 });
  });

  // The acceptance criterion: the tail must be REACHABLE, not merely flagged.
  it("reaches every row the lane holds by paging with offset", async () => {
    const ordered = serveLane(deepLane);

    const seen: string[] = [];
    for (let offset = 0; ; offset += 10) {
      const page = await loadInbox({ offset });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.truncated) break;
      expect(offset).toBeLessThan(ordered.length); // guard against a paging loop
    }

    expect(seen).toEqual(ordered.map((r) => r.id));
    expect(seen.filter((id) => id.startsWith("low-"))).toEqual(["low-0", "low-1"]);
  });

  // The A/B reproducer from the filing, as a unit test: changing ONLY priority
  // moves a row across the waterline, and reverting it moves the row back.
  // Reversibility is what distinguishes a cap from a coincidence.
  it("is reversible — a row's reachability flips with priority alone", async () => {
    // Freshly touched, so within whichever band it lands in it sorts FIRST —
    // the shape the filed reproducer had (BLO-38471 appeared at the top of the
    // medium band the moment its priority changed).
    const subject = row("subject", "low", "2026-10-01T20:15:00.000Z");
    const lane = [...deepLane, subject];

    serveLane(lane);
    const asLow = await loadInbox();
    expect(asLow.rows.map((r) => r.id)).not.toContain("subject");

    subject.priority = "medium";
    serveLane(lane);
    const asMedium = await loadInbox();
    expect(asMedium.rows.map((r) => r.id)).toContain("subject");

    subject.priority = "low";
    serveLane(lane);
    const revertedToLow = await loadInbox();
    expect(revertedToLow.rows.map((r) => r.id)).not.toContain("subject");
  });

  // The signal must survive the eligibility filters, which only ever SHORTEN
  // the page. Deriving truncation from the returned length instead reads a full
  // raw window with withheld rows as complete — the same silent-prefix bug one
  // layer in.
  it("stays truncated when eligibility filters shorten the page below the limit", async () => {
    const held = deepLane.map((r) =>
      r.priority === "high"
        ? { ...r, activeRun: { id: "run-other", status: "running" } }
        : r,
    );
    serveLane(held);

    const inbox = await loadInbox();

    expect(inbox.rows.length).toBeLessThan(inbox.appliedLimit);
    expect(inbox.truncated).toBe(true);
  });

  // Mutation-found (per the 2026-09-17 ruling: revert each guard alone and
  // confirm the suite goes red). The test above only exercises the foreign-run
  // filter, which runs AFTER `eligibleRows` is built — so deriving the signal
  // from `eligibleRows.length` passed it while still being wrong. The worktree
  // cutoff shortens the page one step EARLIER, and pins the probe to the raw
  // window rather than to any particular post-query filter.
  it("stays truncated when the worktree cutoff shortens the page below the limit", async () => {
    serveLane(deepLane.map((r, i) => ({ ...r, createdAt: i < 6 ? "2026-01-01T00:00:00.000Z" : r.createdAt })));

    const inbox = await loadInbox({
      isWorktreeRuntime: true,
      worktreeActivation: {
        armed: true,
        cutoff: "2026-06-01T00:00:00.000Z",
        activationInstanceId: "worktree-1",
        reason: null,
      },
    });

    expect(inbox.rows.length).toBeLessThan(inbox.appliedLimit);
    expect(inbox.truncated).toBe(true);
  });
});

// The MCP half of this contract — headers -> an object the agent cannot read past —
// is pinned in packages/mcp-server/src/tools.test.ts, where the tool is exercised
// against a mocked fetch. The contract is the pair; keep them in step.

/**
 * The glue between the two halves above, which neither of them covers.
 *
 * `routes/agents.ts` is the ONLY place `inbox.truncated` becomes
 * `X-Result-Truncated`, and the only place `offset` is validated. Without this
 * block you can delete the `res.setHeader` call and every other test in this PR
 * still passes while the MCP envelope silently never fires — i.e. the exact
 * silent-prefix defect BLO-39015 exists to kill, restored with a green suite.
 *
 * Mutation-checked per the 2026-09-17 rule, each guard reverted ALONE:
 *   - drop `res.setHeader(ISSUE_LIST_TRUNCATED_HEADER)` -> the cap+1 case fails;
 *   - drop `res.setHeader(ISSUE_LIST_APPLIED_LIMIT_HEADER)` -> both cap cases fail;
 *   - drop the `parseUnsupportedPaginationParams` 400 -> both the `page` and
 *     `perPage` cases fail (status `200 !== 400`, and `list` is reached);
 *   - drop the `parseOffsetParam === null` 400 -> both rejection cases fail;
 *   - pass a literal `0` instead of `parsedOffset` -> the paging case fails;
 *   - weaken `parseOffsetParam`'s `Number.isSafeInteger` to `Number.isFinite`
 *     or `Number.isInteger` -> the 308-nines rejection case fails (309 nines
 *     parses to `Infinity` and fails all three, so it cannot catch this).
 */
describe("REST — GET /api/agents/me/inbox-lite (BLO-39015)", () => {
  const CAP = ISSUE_LIST_DEFAULT_LIMIT;

  function restRow(index: number) {
    return row(`rest-${String(index).padStart(4, "0")}`, "medium");
  }

  /** Honour whatever limit AND offset the route asks for: a mock that ignored
   *  `limit` would make the suite pass against a route that never over-fetches,
   *  and one that ignored `offset` would replay window 0 forever. */
  function serveRestPopulation(population: number) {
    mockIssueService.list.mockImplementation(
      async (_companyId: string, filters: { limit?: number; offset?: number }) => {
        const offset = filters.offset ?? 0;
        const limit = filters.limit ?? population;
        return Array.from({ length: population }, (_, i) => restRow(i)).slice(offset, offset + limit);
      },
    );
  }

  async function buildApp() {
    const { agentRoutes } = await import("../routes/agents.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "agent",
        agentId: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        source: "agent_key",
        runId: "run-1",
      };
      next();
    });
    app.use("/api", agentRoutes({} as never, {} as never));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // The route reads PAPERCLIP_IN_WORKTREE straight off process.env, so the
    // `isWorktreeRuntime` argument the service tests above pass cannot reach
    // it. Left set by the caller, it empties every page while the header
    // assertions still pass.
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "");
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("at cap + 1 available rows: returns exactly cap rows and sets both headers", async () => {
    serveRestPopulation(CAP + 1);

    const res = await request(await buildApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(CAP);
    expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBe("true");
    expect(res.headers[ISSUE_LIST_APPLIED_LIMIT_HEADER.toLowerCase()]).toBe(String(CAP));
  });

  it("at cap - 1 available rows: returns every row and OMITS the truncation header", async () => {
    serveRestPopulation(CAP - 1);

    const res = await request(await buildApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(CAP - 1);
    // Absence is the contract: no header is what a caller reads as "you have
    // every row". A header that is always present carries no information.
    expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBeUndefined();
    expect(res.headers[ISSUE_LIST_APPLIED_LIMIT_HEADER.toLowerCase()]).toBe(String(CAP));
  });

  it("pages the tail with offset rather than replaying window 0", async () => {
    serveRestPopulation(CAP + 3);

    const res = await request(await buildApp())
      .get("/api/agents/me/inbox-lite")
      .query({ offset: String(CAP) });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.headers[ISSUE_LIST_TRUNCATED_HEADER.toLowerCase()]).toBeUndefined();
    expect(res.body.map((r: { id: string }) => r.id)).toEqual(
      [CAP, CAP + 1, CAP + 2].map((i) => restRow(i).id),
    );
  });

  // The two digit-string cases are the only ones that reach the parse at all —
  // the other four are rejected by `^\d+$` — and they pin different guards:
  //   309 nines parses to `Infinity`, so it separates "rejects bad offsets"
  //     from "rejects offsets that fail the regex";
  //   308 nines parses to `1e+308`, which is finite AND an integer but NOT
  //     safe, so it is the only input here that separates the shipped
  //     `Number.isSafeInteger` from `Number.isFinite`/`Number.isInteger`.
  //     Without it that guard has no failing mutation.
  it.each(["-1", "abc", "1.5", "", "9".repeat(308), "9".repeat(309)])(
    "rejects offset=%j with 400 rather than silently serving window 0",
    async (offset) => {
      serveRestPopulation(CAP + 1);

      const res = await request(await buildApp())
        .get("/api/agents/me/inbox-lite")
        .query({ offset });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/offset/);
      expect(mockIssueService.list).not.toHaveBeenCalled();
    },
  );

  // The offset cases above pin a bad offset VALUE. This pins the param NAME —
  // the other half of BLO-24495. `parseOffsetParam(undefined)` is 0, so without
  // the guard `?page=2` is a 200 serving window 0, and on a truncated lane the
  // envelope's `truncated: true` tells the caller there is more while the page
  // it asked for was silently dropped.
  it.each(["page", "perPage"])(
    "rejects %s with 400 rather than silently serving window 0",
    async (param) => {
      serveRestPopulation(CAP + 1);

      const res = await request(await buildApp())
        .get("/api/agents/me/inbox-lite")
        .query({ [param]: "2" });

      expect(res.status).toBe(400);
      expect(res.body.unsupportedParams).toEqual([param]);
      expect(mockIssueService.list).not.toHaveBeenCalled();
    },
  );
});
