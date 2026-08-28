/**
 * @fileoverview BLO-26529 — the masked plugin-config round trip must be
 * concurrency-safe.
 *
 * `POST /api/plugins/:pluginId/config` restores mask sentinels from the stored
 * row before it writes the whole row back. Read and write used to be two
 * separate statements, so a rotation committed inside that window was silently
 * reverted: request B reads secret `S0`, request A rotates `S0 -> S1` and
 * commits, then B writes back the `S0` it restored from its own stale snapshot.
 *
 * These tests drive that interleaving deterministically. The fake `db` below
 * models the two Postgres properties the fix depends on:
 *
 * - transactions run **concurrently** unless something serialises them, so the
 *   test still reproduces the lost update when the lock is removed;
 * - `pg_advisory_xact_lock` is a per-key mutex **held until commit**, and a
 *   second acquirer blocks rather than proceeding.
 *
 * Ordering is driven by explicit events (`aCommitted`, `aBlockedOnLock`) rather
 * than timers, so neither outcome depends on wall-clock timing.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_LOCK_PREFIX = "paperclip:plugin-config:";

const pluginId = "11111111-1111-4111-8111-111111111111";
const companyA = "22222222-2222-4222-8222-222222222222";

/** Secret already stored when both requests start. */
const SECRET_OLD = "sentinel-old-bearer-S0";
/** Value request A rotates to. Must survive request B's stale round trip. */
const SECRET_NEW = "sentinel-new-bearer-S1";

const mockSecretService = vi.hoisted(() => ({
  getById: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

/**
 * Registry backed by a shared committed store plus per-transaction pending
 * writes, so reads observe READ COMMITTED semantics: a transaction sees another
 * transaction's write only once that transaction has committed.
 */
const store = vi.hoisted(() => ({
  committed: {} as Record<string, unknown>,
  plugin: null as Record<string, unknown> | null,
}));

type TxHandle = { __pending: Record<string, unknown> | null } | undefined;

const registryFor = vi.hoisted(() => (handle: TxHandle) => ({
  getById: async () => store.plugin,
  getByKey: async () => store.plugin,
  getConfig: async () => ({
    id: "config-1",
    pluginId,
    companyId: companyA,
    // Uncommitted work in this same transaction is visible to it; everything
    // else reads the last committed value.
    configJson: handle?.__pending ?? store.committed,
  }),
  upsertConfig: async (_pluginId: string, _companyId: string, input: { configJson: Record<string, unknown> }) => {
    if (handle) {
      handle.__pending = input.configJson;
    } else {
      store.committed = input.configJson;
    }
    return { id: "config-1", pluginId, companyId: companyA, configJson: input.configJson };
  },
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: (handle: TxHandle) => registryFor(handle),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ restartWorker: vi.fn() }),
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Fake `db` modelling concurrent transactions and `pg_advisory_xact_lock`.
 *
 * `onLockContended` fires when a transaction has to wait for a lock another
 * transaction already holds — that is the signal the fixed code produces and
 * the buggy code never does.
 */
function createRaceDb(hooks: {
  onLockContended?: () => void;
  beforeCommit?: (txIndex: number) => Promise<void>;
}) {
  /** key -> promise that resolves when the current holder releases. */
  const lockTails = new Map<string, Promise<void>>();
  let txCounter = 0;

  async function acquireAdvisoryLock(key: string): Promise<() => void> {
    const previous = lockTails.get(key);
    const release = deferred();
    lockTails.set(key, previous ? previous.then(() => release.promise) : release.promise);
    if (previous) {
      hooks.onLockContended?.();
      await previous;
    }
    return () => release.resolve();
  }

  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const txIndex = txCounter++;
      const releases: Array<() => void> = [];
      const tx: { __pending: Record<string, unknown> | null; execute: (q: unknown) => Promise<void> } = {
        __pending: null,
        execute: async (q: unknown) => {
          const serialized = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q);
          if (!serialized.includes("pg_advisory_xact_lock")) return;
          const key = serialized.match(new RegExp(`${CONFIG_LOCK_PREFIX}[^"]*`))?.[0];
          if (!key) throw new Error("advisory lock issued without a config-scoped key");
          releases.push(await acquireAdvisoryLock(key));
        },
      };

      try {
        const result = await fn(tx);
        await hooks.beforeCommit?.(txIndex);
        // Commit: publish this transaction's pending write.
        if (tx.__pending !== null) store.committed = tx.__pending;
        return result;
      } finally {
        // Advisory locks are transaction-scoped — released on commit or abort.
        for (const release of releases) release();
      }
    },
  };
}

async function createApp(db: unknown) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(db as never, { installPlugin: vi.fn() } as never, undefined as never));
  app.use(errorHandler);
  return app;
}

function seedPlugin() {
  store.plugin = {
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      instanceConfigSchema: {
        type: "object",
        properties: {
          webhookToken: { type: "string", writeOnly: true },
          endpoint: { type: "string" },
        },
      },
    },
  };
  store.committed = { webhookToken: SECRET_OLD, endpoint: "https://alerts.example.com" };
}

function save(app: express.Express, configJson: Record<string, unknown>) {
  return request(app)
    .post(`/api/plugins/${pluginId}/config`)
    .send({ companyId: companyA, configJson });
}

describe.sequential("masked plugin-config round trip under concurrent writes (BLO-26529)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedPlugin();
    mockSecretService.getById.mockResolvedValue({ id: "secret-1", companyId: companyA, status: "active" });
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("does not revert a rotation committed while a masked save was in flight", async () => {
    const aCommitted = deferred();
    const aBlockedOnLock = deferred();

    const db = createRaceDb({
      onLockContended: () => aBlockedOnLock.resolve(),
      beforeCommit: async (txIndex) => {
        // Transaction 0 is request B (it starts first). Hold it open between its
        // mask-restore read and its commit, which is precisely the window the
        // lost update used to live in. Resume as soon as request A either
        // commits (unserialised — the bug) or blocks on the lock (serialised —
        // the fix), so neither branch can deadlock or hang.
        if (txIndex !== 0) return;
        await Promise.race([aCommitted.promise, aBlockedOnLock.promise]);
      },
    });

    const app = await createApp(db);

    // B: edits an unrelated field and echoes the mask back for the secret.
    const bSave = save(app, { webhookToken: "__redacted__", endpoint: "https://alerts.example.net" });
    // Let B enter its transaction and take the lock before A starts.
    await new Promise((resolve) => setImmediate(resolve));
    // A: rotates the secret.
    const aSave = save(app, { webhookToken: SECRET_NEW, endpoint: "https://alerts.example.com" }).then((res) => {
      aCommitted.resolve();
      return res;
    });

    const [bRes, aRes] = await Promise.all([bSave, aSave]);

    expect(bRes.status).toBe(200);
    expect(aRes.status).toBe(200);

    // The rotated secret is what remains in storage. Without serialisation B
    // restores SECRET_OLD from its stale snapshot and overwrites SECRET_NEW.
    expect(store.committed.webhookToken).toBe(SECRET_NEW);
    expect(store.committed.webhookToken).not.toBe(SECRET_OLD);

    // Neither response leaks a secret back to the caller.
    expect(JSON.stringify(bRes.body)).not.toContain(SECRET_NEW);
    expect(JSON.stringify(aRes.body)).not.toContain(SECRET_NEW);
  }, 20_000);

  it("serialises concurrent saves on the config row rather than interleaving them", async () => {
    let contended = false;
    const db = createRaceDb({ onLockContended: () => { contended = true; } });
    const app = await createApp(db);

    await Promise.all([
      save(app, { webhookToken: "__redacted__", endpoint: "https://one.example.com" }),
      save(app, { webhookToken: SECRET_NEW, endpoint: "https://two.example.com" }),
    ]);

    // Both saves contend for the same advisory key, so one waits for the other.
    expect(contended).toBe(true);
    // Whichever ordering won, the sentinel itself is never persisted.
    expect(store.committed.webhookToken).not.toBe("__redacted__");
  }, 20_000);

  it("keeps the mask sentinel resolving against the newest committed secret", async () => {
    const db = createRaceDb({});
    const app = await createApp(db);

    // A rotates first and commits.
    await save(app, { webhookToken: SECRET_NEW, endpoint: "https://alerts.example.com" });
    // B then round-trips a masked read taken before the rotation.
    const res = await save(app, { webhookToken: "__redacted__", endpoint: "https://alerts.example.net" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The sentinel means "unchanged", and unchanged is the rotated value.
    expect(store.committed.webhookToken).toBe(SECRET_NEW);
    expect(store.committed.endpoint).toBe("https://alerts.example.net");
  }, 20_000);
});
