/**
 * BLO-31036 — what `events.emit`'s `ownershipCheck` actually guarantees, pinned
 * at the host, against a real PostgreSQL.
 *
 * Ally's review of #1582 raised the same Critical twice and asked for exactly
 * one thing: *steal the generation after the host validates it and before the
 * bus dispatches, and then either enforce or explicitly quarantine the stale
 * event — without holding a database lock across arbitrary handlers.* This file
 * is that test, and it does not pretend the answer is "enforce".
 *
 * The contract has two halves and they are asymmetric on purpose:
 *
 *   1. ENFORCED — a generation already gone when `emit` is called is refused.
 *      The bus is never reached. This is the case that actually fires in
 *      production: a displaced worker is normally displaced long before it gets
 *      to its emit, not inside a microsecond window.
 *
 *   2. NOT ENFORCED, DELIBERATELY — a steal committing between the check's
 *      COMMIT and the fan-out still delivers. There is no transaction to join
 *      (the bus is an in-memory fan-out), so the only way to exclude it is to
 *      hold the share lock across subscriber handlers. Handlers run arbitrary
 *      plugin code, so that would let one slow handler block a steal —
 *      recreating the unstealable fence this entire ticket exists to drain.
 *
 * Case 2 is the reason the option is named `ownershipCheck` and carries its own
 * type rather than reusing `fencing`: the `issues.*` / `state.set` fences take
 * the lock inside the mutation's own transaction and hold it to commit, so for
 * those there is no equivalent window. Asserting case 2 here is the point. If
 * someone later makes delivery authoritative (a transactional outbox in the
 * host event subsystem — the only real fix, and not one the emitting side can
 * make), this test SHOULD fail, and its failure is the signal to update the
 * `PluginEventOwnershipCheck` docs and the plugin's expectations with it.
 *
 * Mutation-check: deleting the `assertPluginFencingGeneration` call from
 * `events.emit` in `plugin-host-services.ts` fails case 1 and leaves case 2
 * green — which is precisely the asymmetry being documented.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { companies, createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  derivePluginDatabaseNamespace,
  pluginDatabaseService,
} from "../services/plugin-database.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin-events-ownership-check tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const ALERTMANAGER_PLUGIN_KEY = "paperclip-plugin-alertmanager";
const AGGREGATE_KEY = 'alert-aggregate:v1:["CronJobSuccessStale",null]';
const EVENT_NAME = "alert.firing";

/** Test-local copy of the real manifest's database declaration. */
function alertmanagerManifest(): PaperclipPluginManifestV1 {
  return {
    id: ALERTMANAGER_PLUGIN_KEY,
    apiVersion: 1,
    version: "0.2.0",
    displayName: "Alertmanager Webhook Receiver",
    description: "Test-local copy of the real manifest's database declaration.",
    author: "Paperclip",
    categories: ["connector", "automation"],
    capabilities: [
      "database.namespace.migrate",
      "database.namespace.read",
      "database.namespace.write",
    ],
    entrypoints: { worker: "./dist/worker.js" },
    database: {
      namespaceSlug: "alertmanager",
      migrationsDir: "migrations",
      coreReadTables: ["companies", "issues"],
    },
  };
}

describeEmbeddedPostgres("events.emit ownership check (BLO-31036)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;
  let namespace!: string;
  let companyId!: string;

  const FENCE_TABLE = "alertmanager_aggregate_lifecycle_fences";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-events-ownership-");
    db = createDb(tempDb.connectionString);

    const manifest = alertmanagerManifest();
    namespace = derivePluginDatabaseNamespace(manifest.id, manifest.database!.namespaceSlug);
    const repoRoot =
      path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const packageRoot = path.join(repoRoot, "packages", "plugins", "paperclip-plugin-alertmanager");

    pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: manifest.id,
      packageName: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      categories: manifest.categories,
      manifestJson: manifest,
      status: "installed",
      installOrder: 1,
    });
    // The real migration files, through the production validator — so the fence
    // table these cases lock is the one that ships, not a hand-written stand-in.
    await pluginDatabaseService(db).applyMigrations(pluginId, manifest, packageRoot);

    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Ownership check co" });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Put the fence row into `firing`, held under `token`. */
  async function seedFence(token: string): Promise<void> {
    await db.execute(
      sql.raw(
        `INSERT INTO "${namespace}".${FENCE_TABLE}
           (company_id, aggregate_key, phase, firing_token, owner_instance_id, owner_slot, updated_at)
         VALUES ('${companyId}', '${AGGREGATE_KEY}', 'firing', '${token}', 'instance-a', 'paperclip-0', now())
         ON CONFLICT (company_id, aggregate_key) DO UPDATE
           SET phase = 'firing', firing_token = EXCLUDED.firing_token`,
      ),
    );
  }

  /** A replacement in the same slot claims the fence, exactly as a restart does. */
  async function stealFence(newToken: string): Promise<void> {
    await db.execute(
      sql.raw(
        `UPDATE "${namespace}".${FENCE_TABLE}
            SET firing_token = '${newToken}', owner_instance_id = 'instance-b'
          WHERE company_id = '${companyId}' AND aggregate_key = '${AGGREGATE_KEY}'`,
      ),
    );
  }

  const ownershipCheckFor = (token: string) => ({
    table: FENCE_TABLE,
    match: {
      company_id: companyId,
      aggregate_key: AGGREGATE_KEY,
      phase: "firing",
      firing_token: token,
    },
  });

  /**
   * Host services over a hoisted scoped-bus spy, so `emit` reaching the bus is
   * observable. `onCheckCommitted` fires in the ONE window this test exists to
   * exercise: after the generation check's transaction has committed and before
   * `scopedBus.emit` is called. Wrapping `db.transaction` is what makes that
   * instant addressable from a test at all — the seam is inside the host.
   */
  function makeServices(onCheckCommitted?: () => Promise<void>) {
    const scoped = { emit: vi.fn(async () => ({})), subscribe: vi.fn(), clear: vi.fn() };
    const bus = { forPlugin: () => scoped } as never;

    const dbForHost = onCheckCommitted
      ? (new Proxy(db as object, {
          get(target, prop, receiver) {
            if (prop === "transaction") {
              return async (fn: (tx: unknown) => Promise<unknown>) => {
                const result = await (target as typeof db).transaction(fn as never);
                await onCheckCommitted();
                return result;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        }) as typeof db)
      : db;

    const services = buildHostServices(dbForHost, pluginId, ALERTMANAGER_PLUGIN_KEY, bus);
    return { services, scoped };
  }

  it("refuses to dispatch when the generation is already gone (ENFORCED)", async () => {
    await seedFence("token-original");
    const { services, scoped } = makeServices();

    // Displaced before the emit — the ordinary production sequence.
    await stealFence("token-replacement");

    await expect(
      services.events.emit({
        name: EVENT_NAME,
        companyId,
        payload: { aggregateKey: AGGREGATE_KEY },
        ownershipCheck: ownershipCheckFor("token-original"),
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "fencing_generation_lost", table: FENCE_TABLE },
    });

    // The load-bearing assertion: the bus was never reached, so no subscriber
    // ever saw an event for an aggregate this caller no longer owned.
    expect(scoped.emit).not.toHaveBeenCalled();

    services.dispose();
  });

  it("still dispatches when the steal lands between the check and the fan-out (NOT ENFORCED, documented)", async () => {
    await seedFence("token-original");

    let stolen = false;
    const { services, scoped } = makeServices(async () => {
      if (stolen) return;
      stolen = true;
      // Committed from a separate statement after the check's transaction has
      // ended — i.e. strictly inside the check -> dispatch window.
      await stealFence("token-replacement");
    });

    await services.events.emit({
      name: EVENT_NAME,
      companyId,
      payload: { aggregateKey: AGGREGATE_KEY },
      ownershipCheck: ownershipCheckFor("token-original"),
    });

    expect(stolen).toBe(true);
    // Asserted, not tolerated. This is the residual window the option's name and
    // docs promise callers, and the reason a subscriber must re-establish
    // ownership before doing anything durable rather than trusting delivery.
    // If this ever starts failing, delivery became authoritative — update
    // `PluginEventOwnershipCheck` and the alertmanager plugin's comments too.
    expect(scoped.emit).toHaveBeenCalledTimes(1);

    services.dispose();
  });

  it("dispatches unconditionally when no ownership check is supplied", async () => {
    await seedFence("token-original");
    const { services, scoped } = makeServices();

    await services.events.emit({
      name: EVENT_NAME,
      companyId,
      payload: { aggregateKey: AGGREGATE_KEY },
    });

    expect(scoped.emit).toHaveBeenCalledTimes(1);

    services.dispose();
  });
});
