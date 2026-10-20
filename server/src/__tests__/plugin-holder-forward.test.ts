import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schedulerLeases } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  leaseHolderUrlResolver,
  schedulerLeaseHolder,
  schedulerLeaseHolderAddress,
  schedulerLeaseIdentity,
} from "../services/scheduler-lease.js";
import {
  PLUGIN_HOLDER_FORWARDED_HEADER,
  registerPluginHolderForwardRoutes,
} from "../routes/worker-tier-proxy.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
const LEASE = "heartbeat-timer-plugin-forward-test";

describe("scheduler lease holder address (BLO-47803)", () => {
  it("advertises PAPERCLIP_POD_IP in the holder id and reads it back", () => {
    const prev = process.env.PAPERCLIP_POD_IP;
    process.env.PAPERCLIP_POD_IP = "10.0.0.7";
    try {
      const { holderId } = schedulerLeaseIdentity();
      expect(schedulerLeaseHolderAddress(holderId)).toBe("10.0.0.7");
    } finally {
      if (prev === undefined) delete process.env.PAPERCLIP_POD_IP;
      else process.env.PAPERCLIP_POD_IP = prev;
    }
  });

  it("has no address for an id written without one (pre-BLO-47803 holder)", () => {
    expect(schedulerLeaseHolderAddress("paperclip-0#abcd1234")).toBeNull();
    expect(schedulerLeaseHolderAddress(null)).toBeNull();
  });
});

/**
 * AC3: two app instances against ONE database. Each instance keeps its plugin
 * state in-process, exactly as `plugin-lifecycle.ts` does (an EventEmitter, no
 * DB poll), and the only thing they share is the real `scheduler_leases` row.
 * A lifecycle change made through either instance must be what every webhook
 * through either instance sees, and an SSE stream on either instance must
 * receive the events the holder emits.
 */
describeEmbeddedPostgres("plugin routes are served by the scheduler lease holder (BLO-47803)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const instances: Instance[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-holder-forward-");
    db = createDb(tempDb.connectionString);
  }, 180_000);

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((i) => i.close()));
    await db.delete(schedulerLeases);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  interface Instance {
    pod: string;
    url: string;
    lease: ReturnType<typeof schedulerLeaseHolder>;
    close: () => Promise<void>;
  }

  async function startInstance(pod: string, ip: string, port: number): Promise<Instance> {
    const pluginConfig = new Map<string, string>();
    const bus = new EventEmitter();
    const lease = schedulerLeaseHolder(db, {
      name: LEASE,
      identity: { pod, holderId: `${pod}#test@${ip}` },
      renewIntervalMs: 60_000,
    });
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    const router = express.Router();
    registerPluginHolderForwardRoutes(
      router,
      leaseHolderUrlResolver(db, { name: LEASE, port, lease: () => lease, cacheMs: 0 }),
    );
    router.post("/plugins/:pluginId/config", (req, res) => {
      pluginConfig.set(String(req.params.pluginId), String(req.body.value));
      bus.emit("event", { pluginId: req.params.pluginId, value: req.body.value, emittedBy: pod });
      res.json({ servedBy: pod });
    });
    router.post("/plugins/:pluginId/webhooks/:endpointKey", (req, res) => {
      res.json({ servedBy: pod, config: pluginConfig.get(String(req.params.pluginId)) ?? null });
    });
    router.get("/plugins/:pluginId/bridge/stream/:channel", (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`: served by ${pod}\n\n`);
      const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      bus.on("event", onEvent);
      req.on("close", () => bus.off("event", onEvent));
    });
    app.use("/api", router);
    const server: Server = createServer(app);
    await new Promise<void>((resolve) => server.listen(port, ip, resolve));
    await lease.start();
    return {
      pod,
      url: `http://${ip}:${(server.address() as AddressInfo).port}`,
      lease,
      close: async () => {
        await lease.stop({ release: true });
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      },
    };
  }

  /** Holder first, so the second instance boots as the follower. */
  async function startPair(): Promise<[Instance, Instance]> {
    // Every replica listens on the same port, as in production; two loopback
    // addresses stand in for two pod IPs.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const a = await startInstance("worker-0", "127.0.0.1", port);
    const b = await startInstance("worker-1", "127.0.0.2", port);
    instances.push(a, b);
    expect(a.lease.shouldRunLoop()).toBe(true);
    expect(b.lease.shouldRunLoop()).toBe(false);
    return [a, b];
  }

  const post = async (url: string, body: unknown = {}, headers: Record<string, string> = {}) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { servedBy: string; config?: string | null } };
  };

  it("a config change through the follower reaches every later webhook, whichever pod takes it", async () => {
    const [a, b] = await startPair();

    expect((await post(`${b.url}/api/plugins/p1/config`, { value: "v2" })).body.servedBy).toBe("worker-0");

    // AC1 verifying signal shape: N=20 webhooks, spread over both pods.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(`${(i % 2 ? b : a).url}/api/plugins/p1/webhooks/alert`)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(results.map((r) => r.body.config)).toEqual(Array(20).fill("v2"));
  });

  it("an SSE stream opened on the follower receives events the holder emits", async () => {
    const [a, b] = await startPair();
    const controller = new AbortController();
    const res = await fetch(`${b.url}/api/plugins/p1/bridge/stream/main`, { signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended before ${needle}: ${text}`);
        text += decoder.decode(value);
      }
    };
    await readUntil("served by worker-0");

    await post(`${a.url}/api/plugins/p1/config`, { value: "v3" });
    await readUntil('"value":"v3"');
    expect(text).toContain('"emittedBy":"worker-0"');
    controller.abort();
  });

  it("serves an already-forwarded request where it lands, so a moving lease cannot loop", async () => {
    const [, b] = await startPair();
    const res = await post(`${b.url}/api/plugins/p1/webhooks/alert`, {}, { [PLUGIN_HOLDER_FORWARDED_HEADER]: "1" });
    expect(res.body.servedBy).toBe("worker-1");
  });

  it("follows the lease when it moves", async () => {
    const [a, b] = await startPair();
    await a.lease.stop({ release: true });
    await b.lease.tick();
    expect(b.lease.shouldRunLoop()).toBe(true);

    const res = await post(`${a.url}/api/plugins/p1/webhooks/alert`);
    expect(res).toMatchObject({ status: 200, body: { servedBy: "worker-1" } });
  });
});
