/**
 * BLO-31049 / BLO-31036 — a plugin's fencing generation, enforced by the host.
 *
 * A plugin can enforce its own fence on its own writes but not on a host RPC,
 * so before this it could only manage a check-before-act barrier:
 *
 *     assertFiringGeneration()     // still mine?
 *        <- a steal committing HERE was not caught
 *     await ctx.issues.update()    // committed under the new owner
 *
 * Ally's review of #1582 asked for exactly one thing to be proven: *steal the
 * fence after the barrier and show the old RPC cannot persist.* That is the
 * `it("rejects ...")` cases below.
 *
 * The last case is the one that matters most, and it is the reason these run
 * against a real PostgreSQL rather than PGlite: it uses **two connections** to
 * show the check is a lock and not merely a check performed later. A steal
 * racing an in-flight mutation *blocks* until that mutation's transaction ends,
 * so there is no interleaving to exploit — under READ COMMITTED a check without
 * `FOR SHARE` would still admit a steal committing between check and write.
 *
 * Mutation-test these: reverting `assertPluginFencingGeneration` to a plain
 * `SELECT` (dropping `FOR SHARE`) leaves every case green *except* the
 * concurrency one, which is precisely the property the rest cannot see.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { companies, createDb, issueComments, issues, pluginState, plugins } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { pluginStateStore } from "../services/plugin-state-store.js";
import {
  assertPluginFencingGeneration,
  resolvePluginFencingPrecondition,
} from "../services/plugin-fencing.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/** Stands in for a plugin's own schema — the host derives this, callers never send it. */
const NAMESPACE = "plugin_fencing_test";
const FENCE_TABLE = "aggregate_lifecycle_fences";
const AGGREGATE_KEY = 'alert-aggregate:v1:["CronJobSuccessStale",null]';

describeEmbeddedPostgres("plugin fencing generation enforced by the issues service", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-fencing-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${NAMESPACE}`));
    await db.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS ${NAMESPACE}.${FENCE_TABLE} (
         company_id text NOT NULL,
         aggregate_key text NOT NULL,
         phase text NOT NULL,
         firing_token text,
         PRIMARY KEY (company_id, aggregate_key)
       )`),
    );
  });

  afterEach(async () => {
    await db.execute(sql.raw(`DELETE FROM ${NAMESPACE}.${FENCE_TABLE}`));
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: `fencing ${randomUUID()}`,
        issuePrefix: `FN${randomUUID().slice(0, 6).toUpperCase()}`,
      })
      .returning();
    return company;
  }

  /** Claim the fence for `token`, as `beginAggregateFiring` does. */
  async function claimFence(companyId: string, token: string) {
    await db.execute(
      sql`INSERT INTO ${sql.raw(`${NAMESPACE}.${FENCE_TABLE}`)}
            (company_id, aggregate_key, phase, firing_token)
          VALUES (${companyId}, ${AGGREGATE_KEY}, 'firing', ${token})
          ON CONFLICT (company_id, aggregate_key)
          DO UPDATE SET phase = 'firing', firing_token = EXCLUDED.firing_token`,
    );
  }

  /** A replacement worker stealing the aggregate — the write this must fence against. */
  async function stealFence(companyId: string, nextToken: string) {
    await db.execute(
      sql`UPDATE ${sql.raw(`${NAMESPACE}.${FENCE_TABLE}`)}
             SET firing_token = ${nextToken}
           WHERE company_id = ${companyId} AND aggregate_key = ${AGGREGATE_KEY}`,
    );
  }

  function precondition(companyId: string, token: string) {
    return resolvePluginFencingPrecondition(NAMESPACE, {
      table: FENCE_TABLE,
      match: {
        company_id: companyId,
        aggregate_key: AGGREGATE_KEY,
        phase: "firing",
        firing_token: token,
      },
    });
  }

  it("applies an update while the caller still holds the generation", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    const issue = await svc.create(company.id, { title: "held" });

    const updated = await svc.update(issue.id, {
      description: "written by the fence holder",
      fencingPrecondition: precondition(company.id, token),
    });

    expect(updated?.description).toBe("written by the fence holder");
  });

  it("rejects an update whose generation was stolen after the caller's barrier", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    const issue = await svc.create(company.id, {
      title: "held",
      description: "original",
      status: "cancelled",
    });

    // The plugin's own barrier passes here — it still holds the fence.
    await assertPluginFencingGeneration(db, precondition(company.id, token));
    // ...and the replacement steals it before the RPC lands. This is the exact
    // interleaving Ally's Critical named.
    await stealFence(company.id, randomUUID());

    await expect(
      svc.update(issue.id, {
        status: "todo",
        description: "stale re-open by a displaced predecessor",
        fencingPrecondition: precondition(company.id, token),
      }),
    ).rejects.toMatchObject({ details: { code: "fencing_generation_lost" } });

    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row.status).toBe("cancelled");
    expect(row.description).toBe("original");
  });

  it("rejects an update once the fence has been released outright", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    const issue = await svc.create(company.id, { title: "held", description: "original" });

    await db.execute(sql.raw(`DELETE FROM ${NAMESPACE}.${FENCE_TABLE}`));

    await expect(
      svc.update(issue.id, {
        description: "written after release",
        fencingPrecondition: precondition(company.id, token),
      }),
    ).rejects.toMatchObject({ details: { code: "fencing_generation_lost" } });

    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row.description).toBe("original");
  });

  it("behaves exactly as before when no generation is supplied", async () => {
    const company = await seedCompany();
    const issue = await svc.create(company.id, { title: "unfenced" });

    // No fence row exists at all; an opt-in precondition must not become an
    // implicit requirement for every other plugin and caller.
    const updated = await svc.update(issue.id, { description: "unfenced write" });
    expect(updated?.description).toBe("unfenced write");
  });

  it("creates no issue when the generation was lost before the create", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    await stealFence(company.id, randomUUID());

    await expect(
      svc.create(company.id, {
        title: "orphan filed by a displaced predecessor",
        fencingPrecondition: precondition(company.id, token),
      }),
    ).rejects.toMatchObject({ details: { code: "fencing_generation_lost" } });

    const rows = await db.select().from(issues);
    expect(rows).toHaveLength(0);
  });

  it("writes no comment when the generation was lost, and refuses to fence without a transaction", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    const issue = await svc.create(company.id, { title: "held" });
    await stealFence(company.id, randomUUID());

    // A share lock only fences for the life of its transaction, so addComment
    // must be handed one rather than silently degrading to a barrier.
    await expect(
      svc.addComment(issue.id, "stale", {}, { fencingPrecondition: precondition(company.id, token) }),
    ).rejects.toThrow(/requires an explicit transaction/);

    await expect(
      db.transaction((tx) =>
        svc.addComment(
          issue.id,
          "stale comment from a displaced predecessor",
          {},
          { fencingPrecondition: precondition(company.id, token) },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: { code: "fencing_generation_lost" } });

    const rows = await db.select().from(issueComments);
    expect(rows).toHaveLength(0);
  });

  // BLO-31657: `fencing` and `idempotencyKey` interact, and the order is not the
  // one a plugin author would assume from the dedup docs alone.
  // `assertPluginFencingGeneration` runs *before* the insert and before the
  // return-existing lookup, so once the generation has advanced a duplicate
  // delivery does NOT resolve to the comment its first delivery wrote — it
  // throws. The retry is therefore not idempotent under fencing, and a plugin
  // must read `fencing_generation_lost` as "may already be applied" rather than
  // "not written". Pinned here so the docstring on `issues.createComment` cannot
  // drift back to claiming an unconditional return-existing.
  it("throws rather than returning the existing comment when a fenced retry has lost the generation", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    const issue = await svc.create(company.id, { title: "held" });
    const idempotencyKey = `plugin:test:delivery-${randomUUID()}`;

    // Delivery 1 lands while the caller still holds the fence.
    const first = await db.transaction((tx) =>
      svc.addComment(
        issue.id,
        "delivery 1",
        {},
        { fencingPrecondition: precondition(company.id, token), idempotencyKey },
        tx,
      ),
    );
    expect(await db.select().from(issueComments)).toHaveLength(1);

    // The fence moves to a replacement worker...
    await stealFence(company.id, randomUUID());

    // ...and the redelivery of that same comment now throws, even though the key
    // it carries is already on the issue and dedup alone would have returned it.
    await expect(
      db.transaction((tx) =>
        svc.addComment(
          issue.id,
          "delivery 1 redelivered",
          {},
          { fencingPrecondition: precondition(company.id, token), idempotencyKey },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ details: { code: "fencing_generation_lost" } });

    // Still exactly one row, and it is delivery 1's — the throw wrote nothing,
    // so the error means "already applied", not "lost".
    const rows = await db.select().from(issueComments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
    expect(rows[0]!.body).toBe("delivery 1");
  });

  it("rejects a table or column that is not a bare identifier, and cannot reach another schema", () => {
    for (const table of ['fences"; DROP TABLE issues; --', 'issues" ; --', "public.issues", ""]) {
      expect(() =>
        resolvePluginFencingPrecondition(NAMESPACE, { table, match: { company_id: "c" } }),
      ).toThrow(/Invalid fencing precondition/);
    }
    expect(() =>
      resolvePluginFencingPrecondition(NAMESPACE, {
        table: FENCE_TABLE,
        match: { 'company_id" = company_id OR "1': "1" },
      }),
    ).toThrow(/Invalid fencing precondition/);
    // An empty match would degrade to "any row in the table", which is not a fence.
    expect(() =>
      resolvePluginFencingPrecondition(NAMESPACE, { table: FENCE_TABLE, match: {} }),
    ).toThrow(/Invalid fencing precondition/);
  });

  /**
   * The property none of the above can see.
   *
   * Every case so far steals *before* the mutation starts, which a plain
   * `SELECT` check would also catch. This one starts the steal while the
   * mutation is mid-transaction — the window that made the plugin-side barrier
   * insufficient. If the check did not hold a row lock, the steal would commit
   * during the sleep and the stale write would still land.
   */
  it("serializes a steal that races an in-flight mutation, instead of interleaving with it", async () => {
    const company = await seedCompany();
    const token = randomUUID();
    await claimFence(company.id, token);
    const issue = await svc.create(company.id, { title: "held", description: "original" });

    const order: string[] = [];
    let releaseSteal!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      releaseSteal = resolve;
    });

    const mutation = db.transaction(async (tx) => {
      await assertPluginFencingGeneration(tx, precondition(company.id, token));
      // The lock is now held. Let the steal start and give it room to commit if
      // it can — if it can, this test fails, which is the point.
      releaseSteal();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx
        .update(issues)
        .set({ description: "written under the fence" })
        .where(eq(issues.id, issue.id));
      order.push("mutation-committed");
    });

    const steal = (async () => {
      await lockTaken;
      await stealFence(company.id, randomUUID());
      order.push("steal-committed");
    })();

    await Promise.all([mutation, steal]);

    // The steal was made to wait; it did not slip between the check and the write.
    expect(order).toEqual(["mutation-committed", "steal-committed"]);

    const [row] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(row.description).toBe("written under the fence");

    // And now that the steal has landed, the displaced predecessor is locked out.
    await expect(
      svc.update(issue.id, {
        description: "stale",
        fencingPrecondition: precondition(company.id, token),
      }),
    ).rejects.toMatchObject({ details: { code: "fencing_generation_lost" } });
  });
});

/**
 * BLO-31036 — the same enforcement, for the state write at the end of a firing
 * delivery.
 *
 * The `issues.*` cases above cover the mutations in the *middle* of a delivery.
 * Ally's re-review of #1582 found the tail was still open: `upsertAggregateMember`
 * is generation-checked, but the `ctx.state.set` that follows it was not, so a
 * steal landing in that gap let a displaced predecessor overwrite the
 * aggregate's alert state with its own stale view. `state.set` now takes the
 * same precondition and applies it inside the upsert's own transaction.
 *
 * The concurrency case is again the load-bearing one and again needs two
 * connections: dropping `FOR SHARE` from `assertPluginFencingGeneration` leaves
 * the rejection cases green and fails only that one.
 */
describeEmbeddedPostgres("plugin fencing generation enforced by the state store", () => {
  let db!: ReturnType<typeof createDb>;
  let store!: ReturnType<typeof pluginStateStore>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;

  const STATE_KEY = "alert:fp-restart-safety";
  const COMPANY = "company-1";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-state-fencing-");
    db = createDb(tempDb.connectionString);
    store = pluginStateStore(db);
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${NAMESPACE}`));
    await db.execute(
      sql.raw(`CREATE TABLE IF NOT EXISTS ${NAMESPACE}.${FENCE_TABLE} (
         company_id text NOT NULL,
         aggregate_key text NOT NULL,
         phase text NOT NULL,
         firing_token text,
         PRIMARY KEY (company_id, aggregate_key)
       )`),
    );
    const [plugin] = await db
      .insert(plugins)
      .values({
        pluginKey: `alertmanager-fencing-${randomUUID().slice(0, 8)}`,
        packageName: "@paperclipai/plugin-alertmanager",
        version: "0.0.0-test",
        manifestJson: {} as never,
      })
      .returning();
    pluginId = plugin.id;
  });

  afterEach(async () => {
    await db.execute(sql.raw(`DELETE FROM ${NAMESPACE}.${FENCE_TABLE}`));
    await db.delete(pluginState);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function claimFence(token: string) {
    await db.execute(
      sql`INSERT INTO ${sql.raw(`${NAMESPACE}.${FENCE_TABLE}`)}
            (company_id, aggregate_key, phase, firing_token)
          VALUES (${COMPANY}, ${AGGREGATE_KEY}, 'firing', ${token})
          ON CONFLICT (company_id, aggregate_key)
          DO UPDATE SET phase = 'firing', firing_token = EXCLUDED.firing_token`,
    );
  }

  async function stealFence(nextToken: string) {
    await db.execute(
      sql`UPDATE ${sql.raw(`${NAMESPACE}.${FENCE_TABLE}`)}
             SET firing_token = ${nextToken}
           WHERE company_id = ${COMPANY} AND aggregate_key = ${AGGREGATE_KEY}`,
    );
  }

  function precondition(token: string) {
    return resolvePluginFencingPrecondition(NAMESPACE, {
      table: FENCE_TABLE,
      match: {
        company_id: COMPANY,
        aggregate_key: AGGREGATE_KEY,
        phase: "firing",
        firing_token: token,
      },
    });
  }

  const write = (value: unknown, token?: string) =>
    store.set(
      pluginId,
      { scopeKind: "company", scopeId: COMPANY, stateKey: STATE_KEY, value },
      token === undefined ? null : precondition(token),
    );

  const readBack = async () => {
    const [row] = await db
      .select()
      .from(pluginState)
      .where(and(eq(pluginState.pluginId, pluginId), eq(pluginState.stateKey, STATE_KEY)));
    return row?.valueJson as { by?: string } | undefined;
  };

  it("applies the state write while the caller still holds the generation", async () => {
    const token = randomUUID();
    await claimFence(token);

    await write({ by: "fence-holder" }, token);

    expect(await readBack()).toEqual({ by: "fence-holder" });
  });

  it("rejects the state write whose generation was stolen after the caller's barrier", async () => {
    const token = randomUUID();
    await claimFence(token);
    await write({ by: "fence-holder" }, token);

    // The predecessor won its member write, then a replacement claimed the
    // aggregate. Its `ctx.state.set` must not land.
    await stealFence(randomUUID());

    await expect(write({ by: "displaced-predecessor" }, token)).rejects.toMatchObject({
      details: { code: "fencing_generation_lost" },
    });
    expect(await readBack()).toEqual({ by: "fence-holder" });
  });

  it("rejects the state write once the fence has been released outright", async () => {
    const token = randomUUID();
    await claimFence(token);
    await db.execute(sql.raw(`DELETE FROM ${NAMESPACE}.${FENCE_TABLE}`));

    await expect(write({ by: "displaced-predecessor" }, token)).rejects.toMatchObject({
      details: { code: "fencing_generation_lost" },
    });
    expect(await readBack()).toBeUndefined();
  });

  it("behaves exactly as before when no generation is supplied", async () => {
    // Every other plugin calls `state.set` without a fence; the new parameter
    // must not make those writes conditional on anything.
    await write({ by: "unfenced" });

    expect(await readBack()).toEqual({ by: "unfenced" });
  });

  it("serializes a steal that races an in-flight state write, instead of interleaving", async () => {
    const token = randomUUID();
    await claimFence(token);

    const order: string[] = [];
    let releaseSteal!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      releaseSteal = resolve;
    });

    const mutation = db.transaction(async (tx) => {
      await assertPluginFencingGeneration(tx, precondition(token));
      // Lock held. Give the steal every chance to commit — if it can, the write
      // below is stale and this test fails, which is the point.
      releaseSteal();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await tx.insert(pluginState).values({
        pluginId,
        scopeKind: "company",
        scopeId: COMPANY,
        namespace: "default",
        stateKey: STATE_KEY,
        valueJson: { by: "written-under-the-fence" },
        updatedAt: new Date(),
      });
      order.push("mutation-committed");
    });

    const steal = (async () => {
      await lockTaken;
      await stealFence(randomUUID());
      order.push("steal-committed");
    })();

    await Promise.all([mutation, steal]);

    expect(order).toEqual(["mutation-committed", "steal-committed"]);
    expect(await readBack()).toEqual({ by: "written-under-the-fence" });

    // And the displaced predecessor is locked out from here on.
    await expect(write({ by: "stale" }, token)).rejects.toMatchObject({
      details: { code: "fencing_generation_lost" },
    });
  });
});
