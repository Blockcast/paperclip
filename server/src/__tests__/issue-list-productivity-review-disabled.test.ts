import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { isProductivityReviewOptedOut } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// PEN-5295: `executionPolicy` is absent from list rows by design, so the durable
// stand-down flag inside it was unreachable from the one surface an attendance sweep
// reads. A row stood down on a human gate carries no `activeRun`, no
// `monitorNextCheckAt`, no `scheduledRetryAt` and no `parkedUntil` — so it scored
// identically to an abandoned row (221/221 rows absent, measured 2026-11-02).
describeEmbeddedPostgres("issue list projection of the productivity-review opt-out (PEN-5295)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  // Every case is `[label, storedPolicy, expected]`, and the policy is fed to BOTH the SQL
  // projection and the TS predicate — so the parity assertion below is over real stored
  // jsonb, not over a hand-written expectation of what the SQL does.
  const cases: Array<[string, unknown, boolean]> = [
    ["no policy at all", null, false],
    ["policy with neither flag", { mode: "normal", commentRequired: true, stages: [] }, false],
    ["durable top-level flag true", { mode: "normal", commentRequired: true, stages: [], productivityReviewDisabled: true }, true],
    ["durable top-level flag false", { mode: "normal", commentRequired: true, stages: [], productivityReviewDisabled: false }, false],
    [
      "monitor-scoped flag true",
      {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z", notes: null, scheduledBy: "assignee", productivityReviewDisabled: true },
      },
      true,
    ],
    [
      "monitor present, flag not set",
      {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z", notes: null, scheduledBy: "assignee" },
      },
      false,
    ],
    // Strictness: the TS predicate is `=== true`, so the SQL must be `= 'true'::jsonb` and
    // not a truthiness test. These are the shapes that would diverge if it were.
    ["string \"true\", not boolean", { mode: "normal", commentRequired: true, stages: [], productivityReviewDisabled: "true" }, false],
    ["number 1, not boolean", { mode: "normal", commentRequired: true, stages: [], productivityReviewDisabled: 1 }, false],
    ["json null", { mode: "normal", commentRequired: true, stages: [], productivityReviewDisabled: null }, false],
    // The nested home must not be read off a non-object monitor.
    ["monitor is a string", { mode: "normal", commentRequired: true, stages: [], monitor: "nope" }, false],
  ];

  const issueIdByLabel = new Map<string, string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-list-prd-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "List Productivity Opt-Out",
      issuePrefix: "LPO",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: randomUUID(), companyId, name: "Owner", role: "engineer" });
    for (const [label, policy] of cases) {
      const [row] = await db
        .insert(issues)
        .values({
          companyId,
          title: label,
          status: "in_progress",
          // Cast deliberately: several cases store shapes the parsed type forbids, because
          // the point is that both predicates refuse them identically.
          executionPolicy: policy as never,
        })
        .returning();
      issueIdByLabel.set(label, row!.id);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("is present on every list row, explicitly false when unset", async () => {
    const rows = await issueService(db).list(companyId);
    expect(rows.length).toBe(cases.length);
    for (const row of rows) {
      // The load-bearing half. `toHaveProperty` fails on an absent key where a
      // `=== false` assertion would pass on `undefined`, which is the defect itself.
      expect(row).toHaveProperty("productivityReviewDisabled");
      expect(typeof row.productivityReviewDisabled).toBe("boolean");
    }
    // ...and the key must never be null, which would reintroduce the same ambiguity.
    expect(rows.every((row) => row.productivityReviewDisabled !== null)).toBe(true);
  });

  it("agrees with the shared predicate on every policy shape, in both homes", async () => {
    const rows = await issueService(db).list(companyId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [label, policy, expected] of cases) {
      const row = byId.get(issueIdByLabel.get(label)!)!;
      expect(row.productivityReviewDisabled, `SQL projection for ${label}`).toBe(expected);
      // SQL/TS parity, against the same stored value rather than against each other's copy.
      expect(isProductivityReviewOptedOut(policy), `shared predicate for ${label}`).toBe(expected);
    }
  });

  it("still carries no executionPolicy object — the scalar replaces it, it does not reopen it", async () => {
    const rows = await issueService(db).list(companyId);
    const stoodDown = rows.find((row) => row.title === "durable top-level flag true")!;
    // BLO-40082: the object stays absent (unbounded, whole-replaced on PATCH).
    expect(stoodDown).not.toHaveProperty("executionPolicy");
    expect(stoodDown.productivityReviewDisabled).toBe(true);
    // The single-issue read is the surface that carries the policy, and it does NOT carry
    // the scalar — so a consumer there derives it with the shared predicate.
    const single = await issueService(db).getById(stoodDown.id);
    expect(isProductivityReviewOptedOut(single?.executionPolicy)).toBe(true);
  });

  it("is independent of the four attendance fields — a stand-down is attended by nothing", async () => {
    const rows = await issueService(db).list(companyId);
    const stoodDown = rows.find((row) => row.title === "durable top-level flag true")!;
    // The exact shape that made this row indistinguishable from an abandoned one. If any of
    // these ever becomes non-null for a bare stand-down, the premise of the fix has changed.
    expect(stoodDown.activeRun).toBeNull();
    expect(stoodDown.monitorNextCheckAt).toBeNull();
    expect(stoodDown.scheduledRetryAt).toBeNull();
    expect(stoodDown.parkedUntil).toBeNull();
    expect(stoodDown.productivityReviewDisabled).toBe(true);
  });
});
