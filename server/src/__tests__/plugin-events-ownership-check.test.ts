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
 *   1. ENFORCED AT EMIT — a generation already gone when `emit` is called is
 *      refused. The bus is never reached. This is the case that actually fires
 *      in production: a displaced worker is normally displaced long before it
 *      gets to its emit, not inside a microsecond window.
 *
 *   2. ENFORCED AT THE POINT OF ACTION (BLO-31113) — a steal committing
 *      between the check's COMMIT and the fan-out still DELIVERS. There is no
 *      transaction to join (the bus is an in-memory fan-out), and holding the
 *      share lock across subscriber handlers is rejected: handlers run
 *      arbitrary plugin code, so one slow handler would block a steal —
 *      recreating the unstealable fence BLO-31036 exists to drain. What changed
 *      is that the checked generation now travels on the envelope as
 *      `event.ownership`, and a subscriber passing it as `fencing` on the
 *      mutation it acts with is refused under the host lock once the
 *      generation is superseded. Delivery is a notification; the stamp is the
 *      authorization.
 *
 * Case 2 used to assert only "still delivers" and was the documented gap. It
 * is rewritten, not deleted: delivery is still asserted, and so is the
 * refusal of the stale stamp, against a control proving the same stamp is
 * accepted while the generation is current.
 *
 * Mutation-check: deleting the `assertPluginFencingGeneration` call from
 * `events.emit` fails case 1; dropping the stamp passed to `scopedBus.emit`
 * fails case 2 (the stale event's `ownership` is undefined, so the fenced
 * write is admitted); deleting the `pluginKey` guard in
 * `resolveCallerFencingPrecondition` fails case 3.
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

describeEmbeddedPostgres("events.emit ownership check (BLO-31036, BLO-31113)", () => {
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

  /** The envelope a subscriber would receive, rebuilt from the bus spy. */
  function deliveredOwnership(scoped: { emit: ReturnType<typeof vi.fn> }) {
    const call = scoped.emit.mock.calls.at(-1) as unknown[] | undefined;
    return call?.[3] as { pluginKey: string; table: string; match: Record<string, string> } | undefined;
  }

  /** A subscriber acting on the event, fenced by the stamp it was delivered. */
  function actOnEvent(
    services: ReturnType<typeof buildHostServices>,
    fencing: unknown,
  ): Promise<void> {
    return services.state.set({
      scopeKind: "instance",
      stateKey: `acted:${randomUUID()}`,
      value: { acted: true },
      fencing,
    } as never);
  }

  it("delivers a steal-window event, but its stamped generation refuses the subscriber's action (ENFORCED AT ACTION)", async () => {
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
    // Delivery is NOT suppressed — asserted, not tolerated. No lock spans the
    // fan-out, by design.
    expect(scoped.emit).toHaveBeenCalledTimes(1);

    // The envelope carries the generation the emitter asserted…
    const ownership = deliveredOwnership(scoped);
    expect(ownership).toEqual({
      pluginKey: ALERTMANAGER_PLUGIN_KEY,
      ...ownershipCheckFor("token-original"),
    });

    // …so a subscriber acting with it is refused under the host lock.
    await expect(actOnEvent(services, ownership)).rejects.toMatchObject({
      status: 409,
      details: { code: "fencing_generation_lost", table: FENCE_TABLE },
    });

    services.dispose();
  });

  it("accepts the same stamped generation while it is still current (control)", async () => {
    await seedFence("token-original");
    const { services, scoped } = makeServices();

    await services.events.emit({
      name: EVENT_NAME,
      companyId,
      payload: { aggregateKey: AGGREGATE_KEY },
      ownershipCheck: ownershipCheckFor("token-original"),
    });

    // Without this, the refusal above could be a malformed stamp, not a steal.
    await expect(actOnEvent(services, deliveredOwnership(scoped))).resolves.toBeUndefined();

    services.dispose();
  });

  it("refuses a stamp from another plugin instead of resolving it against the caller's namespace", async () => {
    await seedFence("token-original");
    const { services } = makeServices();

    await expect(
      actOnEvent(services, {
        pluginKey: "some.other-plugin",
        ...ownershipCheckFor("token-original"),
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "fencing_precondition_foreign" },
    });

    services.dispose();
  });

  it("dispatches unconditionally, unstamped, when no ownership check is supplied", async () => {
    await seedFence("token-original");
    const { services, scoped } = makeServices();

    await services.events.emit({
      name: EVENT_NAME,
      companyId,
      payload: { aggregateKey: AGGREGATE_KEY },
    });

    expect(scoped.emit).toHaveBeenCalledTimes(1);
    expect(deliveredOwnership(scoped)).toBeUndefined();

    services.dispose();
  });
});
