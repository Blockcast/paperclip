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
// `buildIssueMonitorClearedPatch` — so `triggered` and `cleared` are byte-identical on this
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

describeEmbeddedPostgres("issue list projection of the monitor lifecycle state (PEN-5481)", () => {
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
    for (const [label, state] of cases) {
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
});
