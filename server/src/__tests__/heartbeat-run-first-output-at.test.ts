import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * `first_output_at` exists to answer one question `last_output_at` cannot:
 * how long did a run take to emit its FIRST byte. See migration 0245 — the
 * reaper's 15m silence floor is applied uniformly to started
 * external-lifecycle runs, and splitting it safely (so a run that never spoke
 * is not held for the full floor a streaming run needs) requires the
 * distribution of first-output latency on healthy runs, which nothing recorded.
 *
 * Both properties below are load-bearing:
 *
 *   write-once — if a later flush could move it, the column becomes a second
 *     copy of `last_output_at` and answers nothing. This is the whole point of
 *     the column, and the failure would be silent: every value would still
 *     look like a plausible timestamp.
 *   COALESCE, not read-then-write — concurrent flushes on the same run must
 *     not race, and the hot output path must not pay an extra SELECT.
 */
describeEmbeddedPostgres("heartbeat run first_output_at", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-first-output-at-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun() {
    // issue_prefix is uniquely indexed, so a fixed literal collides across the
    // cases in this file.
    const suffix = randomUUID().replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase();
    const company = await db
      .insert(companies)
      .values({ name: `first-output-${randomUUID()}`, issuePrefix: `F${suffix}` })
      .returning()
      .then((rows) => rows[0]);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Ally", role: "reviewer" })
      .returning()
      .then((rows) => rows[0]);
    const run = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: agent.id, status: "running" })
      .returning()
      .then((rows) => rows[0]);
    return run;
  }

  // The exact expression the production flush site uses. Kept here verbatim so
  // the semantics this suite asserts are the semantics that ship.
  const flushOutputProgress = (runId: string, at: Date) =>
    db
      .update(heartbeatRuns)
      .set({
        firstOutputAt: sql`COALESCE(${heartbeatRuns.firstOutputAt}, ${at.toISOString()}::timestamptz)`,
        lastOutputAt: at,
      })
      .where(eq(heartbeatRuns.id, runId));

  const read = async (runId: string) =>
    db
      .select({ firstOutputAt: heartbeatRuns.firstOutputAt, lastOutputAt: heartbeatRuns.lastOutputAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);

  it("is null on a run that has never emitted output", async () => {
    // NULL is not an absence of data here, it IS the signal: it distinguishes
    // "went quiet after talking" from "never said anything", which is exactly
    // the distinction the silence floor cannot currently make.
    const run = await seedRun();
    expect((await read(run.id)).firstOutputAt).toBeNull();
  });

  it("records the first flush and does not move on later ones", async () => {
    const run = await seedRun();
    const first = new Date("2026-09-18T20:00:00.000Z");
    const second = new Date("2026-09-18T20:07:30.000Z");
    const third = new Date("2026-09-18T20:15:00.000Z");

    await flushOutputProgress(run.id, first);
    expect((await read(run.id)).firstOutputAt?.toISOString()).toBe(first.toISOString());

    await flushOutputProgress(run.id, second);
    await flushOutputProgress(run.id, third);

    const after = await read(run.id);
    expect(after.firstOutputAt?.toISOString()).toBe(first.toISOString());
    // last_output_at must still advance — the two columns answer different
    // questions, and collapsing them is the regression this guards.
    expect(after.lastOutputAt?.toISOString()).toBe(third.toISOString());
  });

  it("is not moved backwards by an out-of-order flush", async () => {
    // Flush ordering is not guaranteed under concurrency. COALESCE keeps the
    // first WRITE, which is the durable, race-free choice; a MIN()-style
    // "earliest timestamp" rule would need a read-modify-write and could still
    // interleave.
    const run = await seedRun();
    const later = new Date("2026-09-18T21:00:00.000Z");
    const earlier = new Date("2026-09-18T20:30:00.000Z");

    await flushOutputProgress(run.id, later);
    await flushOutputProgress(run.id, earlier);

    expect((await read(run.id)).firstOutputAt?.toISOString()).toBe(later.toISOString());
  });

  it("the production flush site writes it through COALESCE", async () => {
    // A plain `firstOutputAt: pendingOutputProgress.at` would typecheck, pass
    // every behavioural test that only reads one flush, and silently turn this
    // column into a duplicate of last_output_at. Pin the shape at the source.
    //
    // `firstOutputAt: heartbeatRuns.firstOutputAt` is the SELECT-projection
    // form and is excluded deliberately — it reads the column, it does not
    // write it. Every OTHER assignment is a write and must be write-once.
    //
    // Scans ALL of server/src, not just heartbeat.ts: a second write site
    // added in any other file is exactly the regression this guards against,
    // and pinning one path let it through silently. Test files are skipped
    // because this asserts about production code — and because this file's own
    // regex literals would otherwise match themselves.
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          await walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          sources.push(await fs.readFile(full, "utf8"));
        }
      }
    };
    await walk(root);

    // `[^\n]+`, not `[^,\n]+`: stopping at the first comma truncated the match
    // to `firstOutputAt: sql\`COALESCE(${heartbeatRuns.firstOutputAt}`, which
    // contained "COALESCE" only because COALESCE happens to precede that
    // comma. A write whose COALESCE came later would have passed.
    const all = sources.flatMap((src: string) => src.match(/firstOutputAt:\s*[^\n]+/g) ?? []);
    const projections = all.filter((a: string) =>
      /^firstOutputAt:\s*heartbeatRuns\.firstOutputAt,?$/.test(a.trim()),
    );
    const writes = all.filter((a: string) => !projections.includes(a));

    expect(all.length).toBeGreaterThan(0);
    expect(writes.length).toBe(1);
    for (const write of writes) {
      expect(write).toContain("COALESCE");
    }
  });
});
