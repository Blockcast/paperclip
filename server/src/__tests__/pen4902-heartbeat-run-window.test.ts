// PEN-4902: `GET /companies/:companyId/heartbeat-runs` accepted `from`, `to`
// and `countOnly` and dropped all three on the floor -- the route read
// `companyId`, `agentId`, `limit` and `summary` and nothing else. A caller
// date-ranging runs got a 200, a plausible shape, and the newest rows in the
// company under a window label; the Cfo seat asked for 11-02 -> 11-03 and was
// handed a run created that afternoon. The answer looked like data, so nothing
// re-checked it.
//
// These tests pin the service half of the repair against a real database,
// because the interesting part is not that a predicate exists but which rows
// it admits: the window is HALF-OPEN on `created_at`, so chained day windows
// cannot both claim a run created exactly on the shared boundary instant.
// That differs from the inclusive `to` of `parseCostDateRange`, and the
// boundary cases below are the only place that difference is written down
// executably.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat-run window tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RunRow = { id: string; agentId: string; createdAt: Date | string };

/** `list` returns a union of three projections; the window tests only need these three columns. */
async function listRuns(
  heartbeat: ReturnType<typeof heartbeatService>,
  companyId: string,
  agentId: string | undefined,
  createdAtWindow: { from?: Date; to?: Date },
): Promise<RunRow[]> {
  return (await heartbeat.list(companyId, agentId, undefined, {
    summary: true,
    ...createdAtWindow,
  })) as unknown as RunRow[];
}

const BOUNDARY = new Date("2026-11-03T00:00:00.000Z");
const BEFORE = new Date("2026-11-02T12:00:00.000Z");
const AFTER = new Date("2026-11-03T12:00:00.000Z");

describeEmbeddedPostgres("company heartbeat-run window (PEN-4902)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentA!: string;
  let agentB!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-window-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    companyId = randomUUID();
    agentA = randomUUID();
    agentB = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "PEN",
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [[agentA, "Agent A"], [agentB, "Agent B"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
  });

  async function seedRuns() {
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: agentA, invocationSource: "timer", status: "completed", createdAt: BEFORE },
      { companyId, agentId: agentA, invocationSource: "timer", status: "completed", createdAt: BOUNDARY },
      { companyId, agentId: agentA, invocationSource: "timer", status: "completed", createdAt: AFTER },
      { companyId, agentId: agentB, invocationSource: "timer", status: "completed", createdAt: AFTER },
    ]);
  }

  it("returns only runs created inside the requested window", async () => {
    await seedRuns();
    const rows = await listRuns(heartbeat, companyId, undefined, {
      from: BOUNDARY,
      to: new Date("2026-11-04T00:00:00.000Z"),
    });
    const created = rows.map((row) => new Date(row.createdAt).toISOString()).sort();
    expect(created).toEqual([BOUNDARY.toISOString(), AFTER.toISOString(), AFTER.toISOString()].sort());
  });

  it("is half-open: `from` includes the boundary instant and `to` excludes it", async () => {
    await seedRuns();

    const lower = await listRuns(heartbeat, companyId, agentA, { from: BOUNDARY });
    expect(lower.map((row) => new Date(row.createdAt).getTime())).toContain(BOUNDARY.getTime());

    const upper = await listRuns(heartbeat, companyId, agentA, { to: BOUNDARY });
    expect(upper.map((row) => new Date(row.createdAt).getTime())).not.toContain(BOUNDARY.getTime());

    // The property that matters, stated directly: two adjacent day windows
    // partition the runs rather than double-counting the shared instant.
    const dayOne = await listRuns(heartbeat, companyId, agentA, {
      from: new Date("2026-11-02T00:00:00.000Z"),
      to: BOUNDARY,
    });
    const dayTwo = await listRuns(heartbeat, companyId, agentA, {
      from: BOUNDARY,
      to: new Date("2026-11-04T00:00:00.000Z"),
    });
    const ids = [...dayOne, ...dayTwo].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(3);
  });

  it("scopes the window to one agent when agentId is supplied", async () => {
    await seedRuns();
    const rows = await listRuns(heartbeat, companyId, agentB, { from: BOUNDARY });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(agentB);
  });

  it("counts the same window the list returns, without shipping the rows", async () => {
    await seedRuns();
    const createdAtWindow = { from: BOUNDARY, to: new Date("2026-11-04T00:00:00.000Z") };

    expect(await heartbeat.countRuns(companyId, undefined, createdAtWindow)).toBe(3);
    expect(await heartbeat.countRuns(companyId, agentA, createdAtWindow)).toBe(2);
    expect(await heartbeat.countRuns(companyId, agentA, { to: BOUNDARY })).toBe(1);

    // Must-trip control: an unwindowed count is the whole company, so a count
    // that silently ignored the window would read 4 on every assertion above.
    expect(await heartbeat.countRuns(companyId)).toBe(4);
  });

  it("returns an empty window rather than the newest rows when nothing matches", async () => {
    await seedRuns();
    const createdAtWindow = { from: new Date("2026-10-01T00:00:00.000Z"), to: new Date("2026-10-02T00:00:00.000Z") };
    expect(await listRuns(heartbeat, companyId, undefined, createdAtWindow)).toEqual([]);
    expect(await heartbeat.countRuns(companyId, undefined, createdAtWindow)).toBe(0);
  });
});
