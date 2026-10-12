import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { loadAgentInboxLite } from "../services/agent-inbox-lite.js";

// BLO-44922: inbox-lite inherited the list default — priority band, then
// newest ACTIVITY first. With inflow >= drain every new row lands on top of
// its band and the band's oldest row is never reached (measured on Ally: a
// 36-day-old `medium` row at the bottom of 286). This drives the real query
// on a real database: an agent that always takes the first row, with one new
// `medium` row arriving per pick, must reach the oldest row in bounded picks
// — and must still take a `critical` before it.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("inbox-lite pick order (BLO-44922)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-inbox-pick-order-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("reaches a band's oldest row under steady inflow, without crossing bands", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pick order",
      issuePrefix: "PCK",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({ id: agentId, companyId, name: "Picker", role: "engineer", status: "idle" });

    const base = Date.parse("2026-09-01T00:00:00.000Z");
    let n = 0;
    async function insert(priority: string, createdAtMs: number) {
      const id = randomUUID();
      n += 1;
      // Activity tracks creation, as in the field: newest row is also the
      // most recently active one, so the old order never reaches the oldest.
      await db.insert(issues).values({
        id,
        companyId,
        identifier: `PCK-${n}`,
        title: `row ${n}`,
        status: "todo",
        priority,
        assigneeAgentId: agentId,
        originKind: "manual",
        originFingerprint: "default",
        createdAt: new Date(createdAtMs),
        updatedAt: new Date(createdAtMs),
      });
      return id;
    }

    const SEED = 20;
    const oldest = await insert("medium", base);
    for (let i = 1; i < SEED; i += 1) await insert("medium", base + i * 60_000);
    // Newest row of all, but `critical`: it must still be picked first.
    const critical = await insert("critical", base + 10 * 86_400_000);

    const svc = issueService(db);
    const picked: string[] = [];
    let clock = base + 20 * 86_400_000;
    for (let pick = 0; pick < SEED + 2 && !picked.includes(oldest); pick += 1) {
      const { rows } = await loadAgentInboxLite({
        issuesSvc: svc,
        recoveryActionsSvc: { listActiveForIssues: async () => new Map() } as any,
        companyId,
        agentId,
        callerRunId: null,
        limit: 500,
        isWorktreeRuntime: false,
        worktreeActivation: { armed: false, cutoff: null, activationInstanceId: null, reason: "not_worktree_runtime" },
      } as any);
      const first = rows[0]!.id;
      picked.push(first);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first));
      // Inflow == drain: one new `medium` row per pick, always the newest.
      clock += 60_000;
      await insert("medium", clock);
    }

    expect(picked[0]).toBe(critical);
    // Bounded: the oldest `medium` is the very next pick after the critical.
    expect(picked[1]).toBe(oldest);
  });
});
