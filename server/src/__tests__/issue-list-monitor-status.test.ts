import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// PEN-5481: `executionState.monitor` is absent from list rows by design, and the comment
// on `issueListSelect` justified that by saying it is "mirrored by the monitor_* columns".
// That holds for the monitor's SCHEDULING fields and not for its lifecycle state: a fire
// nulls `monitorNextCheckAt` and leaves `monitorLastTriggeredAt` standing, and so does
// `buildIssueMonitorClear` — so `triggered` and `cleared` are byte-identical on this
// surface while their attendance verdicts are opposite. Every list-based attendance sweep
// (DevOps's `check-in-review-dark-rows.mjs`, the CTO HEARTBEAT §S7 predicate) was reading a
// surface that could not answer the question it was asking.
const MONITOR_SCHEDULING_FIELDS = {
  nextCheckAt: null,
  lastTriggeredAt: "2026-04-10T00:00:00.000Z",
  attemptCount: 1,
  notes: "Check deploy",
  scheduledBy: "assignee" as const,
};

describeEmbeddedPostgres("projections of the monitor lifecycle state (PEN-5481, PEN-5935)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  // `[label, storedExecutionState, expectedMonitorStatus]`. The state is stored as real
  // jsonb and read back through the projection, so these assert the SQL, not a transcript
  // of what the SQL was meant to do.
  const cases: Array<[string, unknown, string | null]> = [
    ["no execution state at all", null, null],
    ["execution state with no monitor", { status: "idle", completedStageIds: [] }, null],
    ["monitor scheduled", { status: "idle", monitor: { ...MONITOR_SCHEDULING_FIELDS, status: "scheduled", nextCheckAt: "2099-01-01T00:00:00.000Z" } }, "scheduled"],
    ["monitor triggered", { status: "idle", monitor: { ...MONITOR_SCHEDULING_FIELDS, status: "triggered" } }, "triggered"],
    ["monitor cleared", { status: "idle", monitor: { ...MONITOR_SCHEDULING_FIELDS, status: "cleared", clearReason: "trigger_stalled" } }, "cleared"],
    // The shapes that would make a naive `->>` lie rather than return null.
    ["monitor is json null", { status: "idle", monitor: null }, null],
    ["monitor is a string", { status: "idle", monitor: "nope" }, null],
    ["monitor is an array", { status: "idle", monitor: [{ status: "triggered" }] }, null],
    ["monitor present, status absent", { status: "idle", monitor: { ...MONITOR_SCHEDULING_FIELDS } }, null],
  ];

  const issueIdByLabel = new Map<string, string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-monitor-status-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "List Monitor Status",
      issuePrefix: "LMS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: randomUUID(), companyId, name: "Owner", role: "engineer" });
    for (const [index, [label, state]] of cases.entries()) {
      // Mirror the JSON into the monitor_* column the same way the real write path does,
      // so the triggered-vs-cleared comparison below is against a POPULATED column rather
      // than two nulls that would match trivially.
      const monitor = (state as { monitor?: unknown } | null)?.monitor;
      const lastTriggeredAt = monitor && typeof monitor === "object" && !Array.isArray(monitor)
        ? (monitor as { lastTriggeredAt?: unknown }).lastTriggeredAt
        : null;
      const [row] = await db
        .insert(issues)
        .values({
          companyId,
          title: label,
          status: "in_review",
          // Set explicitly: these columns are nullable with no default, and the raw insert
          // here bypasses the create path that normally allocates them. The identifier is
          // what `getByIdentifier` resolves on, and that is the branch `paperclipGetIssue`
          // actually takes — agents pass `PEN-5935`, not a UUID.
          issueNumber: index + 1,
          identifier: `LMS-${index + 1}`,
          // Cast deliberately: several cases store shapes the parsed type forbids, because
          // the point is that the projection refuses them by returning null rather than
          // by throwing or by inventing a status.
          executionState: state as never,
          monitorLastTriggeredAt: typeof lastTriggeredAt === "string" ? new Date(lastTriggeredAt) : null,
        })
        .returning();
      issueIdByLabel.set(label, row!.id);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("is present on every list row", async () => {
    const rows = await issueService(db).list(companyId);
    expect(rows.length).toBe(cases.length);
    for (const row of rows) {
      // The load-bearing half: `toHaveProperty` fails on an absent key, where comparing
      // against null would pass on `undefined` — which is the defect this closes.
      expect(row).toHaveProperty("monitorStatus");
    }
  });

  it("reports the stored status on every execution-state shape", async () => {
    const rows = await issueService(db).list(companyId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [label, , expected] of cases) {
      const row = byId.get(issueIdByLabel.get(label)!)!;
      expect(row.monitorStatus, `projection for ${label}`).toBe(expected);
    }
  });

  // The whole point of the projection: these two rows are indistinguishable on every other
  // list column, and only `monitorStatus` separates "a sweep owns this" from "nothing does".
  it("separates triggered from cleared, which no other list column does", async () => {
    const rows = await issueService(db).list(companyId);
    const triggered = rows.find((row) => row.title === "monitor triggered")!;
    const cleared = rows.find((row) => row.title === "monitor cleared")!;

    for (const row of [triggered, cleared]) {
      expect(row.activeRun).toBeNull();
      expect(row.monitorNextCheckAt).toBeNull();
      expect(row.scheduledRetryAt).toBeNull();
      expect(row.parkedUntil).toBeNull();
    }
    // Byte-identical on the column that was supposed to mirror the monitor — and
    // populated, so this is a real match rather than two nulls agreeing.
    expect(triggered.monitorLastTriggeredAt).not.toBeNull();
    expect(triggered.monitorLastTriggeredAt).toEqual(cleared.monitorLastTriggeredAt);

    expect(triggered.monitorStatus).toBe("triggered");
    expect(cleared.monitorStatus).toBe("cleared");
  });

  // The deliberate omission is narrowed, not reopened: one scalar, no object.
  it("still carries no executionState.monitor object", async () => {
    const rows = await issueService(db).list(companyId);
    const triggered = rows.find((row) => row.title === "monitor triggered")!;
    expect(triggered.executionState).not.toHaveProperty("monitor");
    // `timeoutAt` is deliberately not projected either — see the comment on
    // `issueListSelect`. Since PEN-5481 a triggered monitor is owned whether or not it
    // carries one, so attendance does not need it, and keying attendance off a budget
    // bound is the read-side form of the mistake PEN-5481 fixed on the write side.
    expect(triggered).not.toHaveProperty("monitorTimeoutAt");
  });

  // PEN-5935. PEN-5481 shipped the field on ONE of the two read surfaces. The single-issue
  // read runs a bare `select()` over the table, `monitorStatus` is not a column, and so the
  // key was absent from `GET /api/issues/:id` — for the same rows, in the same deploy, that
  // the list served it populated on. Absent is rendered `null` by `jq`, `.get()` and
  // optional chaining, and `null` on this field is CONTRACTUALLY "no monitor was ever armed
  // on this row", so a GET answered the opposite of the truth for every monitored row.
  //
  // These assert the PAIR, not the new arm: each reads the same stored jsonb through both
  // projections and compares them. Dropping either one fails here. A test that only
  // exercised the new arm would pass on a tree where the list projection had been removed,
  // which is the half of this defect that made it survivable in the first place.
  describe("agreement between the list and single-issue surfaces (PEN-5935)", () => {
    it("is present on the single-issue read for every stored shape", async () => {
      for (const [label] of cases) {
        const issue = await issueService(db).getById(issueIdByLabel.get(label)!);
        // `toHaveProperty` is the load-bearing assertion, exactly as on the list arm:
        // comparing against null would pass on the absent key that IS the defect.
        expect(issue, `getById returned no row for ${label}`).not.toBeNull();
        expect(issue, `single-issue projection for ${label}`).toHaveProperty("monitorStatus");
      }
    });

    it("answers identically on both surfaces for every stored shape", async () => {
      const rows = await issueService(db).list(companyId);
      const listById = new Map(rows.map((row) => [row.id, row]));
      for (const [label, , expected] of cases) {
        const id = issueIdByLabel.get(label)!;
        const listRow = listById.get(id)!;
        const issue = await issueService(db).getById(id);
        expect(listRow.monitorStatus, `list projection for ${label}`).toBe(expected);
        expect(issue!.monitorStatus, `single-issue projection for ${label}`).toBe(expected);
        // Stated as a direct comparison too, so the failure message on a future divergence
        // names the two surfaces rather than one of them and a literal.
        expect(issue!.monitorStatus, `surfaces disagree for ${label}`).toBe(listRow.monitorStatus);
      }
    });

    // The identifier path is a second entry point into the same getter pair, and it is the
    // one agents actually use — `paperclipGetIssue("PEN-5935")` routes here, not through the
    // UUID branch. It had its own `return enriched`, so it could have been fixed on one
    // branch and left on the other.
    it("answers identically when the row is fetched by identifier", async () => {
      const rows = await issueService(db).list(companyId);
      const listById = new Map(rows.map((row) => [row.id, row]));
      for (const [label] of cases) {
        const id = issueIdByLabel.get(label)!;
        const identifier = listById.get(id)!.identifier!;
        expect(identifier).toBeTruthy();
        const byIdentifier = await issueService(db).getByIdentifier(identifier);
        expect(byIdentifier, `getByIdentifier returned no row for ${label}`).not.toBeNull();
        expect(byIdentifier!.id).toBe(id);
        expect(byIdentifier!.monitorStatus, `identifier projection for ${label}`)
          .toBe(listById.get(id)!.monitorStatus);
      }
    });

    // The whole reason the field exists, restated on the surface that was missing it: a
    // fired monitor and a cleared one are byte-identical on every other column of a GET
    // response too, and only this field separates "a sweep owns this row" from "nothing
    // does".
    it("separates triggered from cleared on the single-issue read", async () => {
      const triggered = await issueService(db).getById(issueIdByLabel.get("monitor triggered")!);
      const cleared = await issueService(db).getById(issueIdByLabel.get("monitor cleared")!);

      expect(triggered!.monitorNextCheckAt).toBeNull();
      expect(cleared!.monitorNextCheckAt).toBeNull();
      expect(triggered!.monitorLastTriggeredAt).not.toBeNull();
      expect(triggered!.monitorLastTriggeredAt).toEqual(cleared!.monitorLastTriggeredAt);

      expect(triggered!.monitorStatus).toBe("triggered");
      expect(cleared!.monitorStatus).toBe("cleared");
    });

    // `null` on this field means "no monitor was ever armed", and an absent key renders as
    // `null` through every reader the fleet uses. So the only way a consumer can tell the
    // two apart is key presence — which is exactly what the published contract tells them
    // to gate on, and what the GET surface could not satisfy.
    it("reports a never-armed row as a present key holding null, not as an absent key", async () => {
      const neverArmed = await issueService(db).getById(issueIdByLabel.get("no execution state at all")!);
      expect(neverArmed).toHaveProperty("monitorStatus");
      expect(Object.keys(neverArmed!)).toContain("monitorStatus");
      expect(neverArmed!.monitorStatus).toBeNull();
    });
  });
});
