import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { normalizeAgentApiKeyScope, type AgentApiKeyScope, type DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { createLiveEventTranscriptGate } from "./live-event-transcript-gate.js";

interface WsSocket {
  readyState: number;
  ping(): void;
  send(data: string): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}

interface WsServer {
  clients: Set<WsSocket>;
  on(event: "connection", listener: (socket: WsSocket, req: IncomingMessage) => void): void;
  on(event: "close", listener: () => void): void;
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
  emit(event: "connection", ws: WsSocket, req: IncomingMessage): boolean;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

interface UpgradeContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  /**
   * PEN-3142: the board subscriber's role in the subscribed company. The
   * transcript gate's human short-circuit is operator-grade only, so the role
   * has to travel with the connection — resolving it later would mean a second
   * membership lookup per socket, and defaulting it would silently decide every
   * board watcher as a viewer.
   */
  membershipRole?: string | null;
  /**
   * PEN-3142: the actor source the upgrade authenticated with, in the REST
   * vocabulary, so the transcript gate asks the same question the REST twin
   * does (it refuses the operator short-circuit to `cloud_tenant`). Set
   * explicitly rather than defaulted in the gate — no upgrade path produces
   * `cloud_tenant` today, and this is what makes that a property of this file
   * rather than an assumption downstream.
   */
  actorSource?: "local_implicit" | "session" | "cloud_tenant";
  /** The `local_trusted` board, which has no membership row to carry. */
  trustedLocal?: boolean;
  /**
   * PEN-3142: the agent key's id and normalized scope, read off the same
   * `agentApiKeys` row the upgrade already matched, exactly as the REST
   * middleware stamps them. Without them the transcript gate decides a
   * `skill_test` / `task_bridge` key as an unscoped one, and the socket streams
   * what the REST twin denies it (Ally review 5449228335).
   */
  keyId?: string;
  keyScope?: AgentApiKeyScope;
}

interface IncomingMessageWithContext extends IncomingMessage {
  paperclipWebSocketHandled?: boolean;
  paperclipUpgradeContext?: UpgradeContext;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function isWritableUpgradeSocket(socket: Duplex) {
  const maybeWritableState = socket as Duplex & { writable?: boolean; writableEnded?: boolean; writableDestroyed?: boolean };
  return !socket.destroyed && maybeWritableState.writable !== false && !maybeWritableState.writableEnded && !maybeWritableState.writableDestroyed;
}

function closeUpgradeSocket(socket: Duplex) {
  if (!socket.destroyed) {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").trim();
  if (!isWritableUpgradeSocket(socket)) {
    closeUpgradeSocket(socket);
    return;
  }

  try {
    socket.once("finish", () => closeUpgradeSocket(socket));
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${safe}`);
  } catch (err) {
    logger.warn({ err }, "failed to reject live websocket upgrade");
    closeUpgradeSocket(socket);
  }
}

function parseCompanyId(pathname: string) {
  const match = pathname.match(/^\/api\/companies\/([^/]+)\/events\/ws$/);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

function parseBearerToken(rawAuth: string | string[] | undefined) {
  const auth = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
  if (!auth) return null;
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headersFromIncomingMessage(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(req.headers)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

async function authorizeUpgrade(
  db: Db,
  req: IncomingMessage,
  companyId: string,
  url: URL,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
): Promise<UpgradeContext | null> {
  const queryToken = url.searchParams.get("token")?.trim() ?? "";
  const authToken = parseBearerToken(req.headers.authorization);
  const token = authToken ?? (queryToken.length > 0 ? queryToken : null);

  // Browser board context has no bearer token in local_trusted and authenticated modes.
  if (!token) {
    if (opts.deploymentMode === "local_trusted") {
      return {
        companyId,
        actorType: "board",
        actorId: "board",
        trustedLocal: true,
      };
    }

    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) {
      return null;
    }

    const session = await opts.resolveSessionFromHeaders(headersFromIncomingMessage(req));
    const userId = session?.user?.id;
    if (!userId) return null;

    const [roleRow, memberships] = await Promise.all([
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    const membership = memberships.find((row) => row.companyId === companyId) ?? null;
    if (!roleRow && !membership) return null;

    return {
      companyId,
      actorType: "board",
      actorId: userId,
      actorSource: "session",
      // Null for an instance admin with no membership in this company: the
      // transcript gate then falls through to the authorization service, which
      // answers that case on `allow_instance_admin` rather than on a role.
      membershipRole: membership?.membershipRole ?? null,
    };
  }

  const tokenHash = hashToken(token);
  const key = await db
    .select()
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
    .then((rows) => rows[0] ?? null);

  if (!key || key.companyId !== companyId) {
    return null;
  }

  await db
    .update(agentApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentApiKeys.id, key.id));

  return {
    companyId,
    actorType: "agent",
    actorId: key.agentId,
    keyId: key.id,
    keyScope: normalizeAgentApiKeyScope(key.scopeConfig),
  };
}

/**
 * PEN-3895: cap on the per-socket send queue.
 *
 * Every event now awaits an authorization decision before it is sent
 * (`createLiveEventTranscriptGate`), so each queued event holds a continuation
 * AND the event payload it closed over alive until that decision resolves. With
 * no bound, a subscriber whose decider stalls — a slow or wedged authorization
 * query — accrues one of those per event published company-wide, for as long as
 * the stall lasts. That is a load shape this gate introduced; before it, the
 * send was synchronous and nothing could queue.
 *
 * Sized well above any healthy burst rather than tuned: live events are
 * published one at a time from independent request handlers, so a drained
 * socket sits at a queue depth of ~1 and only a genuinely stuck decider walks
 * this far. Shedding is the right failure here — dropping an event on an
 * overloaded socket matches the existing fail-closed drop on a projection
 * error, and both are strictly better than unbounded retention.
 */
const MAX_PENDING_SENDS_PER_SOCKET = 512;

export function setupLiveEventsWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const cleanupByClient = new Map<WsSocket, () => void>();
  const aliveByClient = new Map<WsSocket, boolean>();

  const pingInterval = setInterval(() => {
    for (const socket of wss.clients) {
      if (!aliveByClient.get(socket)) {
        socket.terminate();
        continue;
      }
      aliveByClient.set(socket, false);
      socket.ping();
    }
  }, 30000);

  wss.on("connection", (socket: WsSocket, req: IncomingMessage) => {
    const context = (req as IncomingMessageWithContext).paperclipUpgradeContext;
    if (!context) {
      socket.close(1008, "missing context");
      return;
    }

    let sendChain: Promise<void> = Promise.resolve();
    // PEN-3895: in-flight depth, and a closed latch. `readyState` alone is not
    // enough to stop work after close — a continuation that is already queued
    // behind a stalled decider will run later, and it should not project or
    // send once the socket is gone.
    let pendingSends = 0;
    let closed = false;

    const projectForSubscriber = createLiveEventTranscriptGate(db, context);

    const unsubscribe = subscribeCompanyLiveEvents(context.companyId, (event) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      if (pendingSends >= MAX_PENDING_SENDS_PER_SOCKET) {
        // Shed rather than grow. Logged per drop so a saturated subscriber is
        // visible as itself instead of as unexplained memory growth.
        logger.warn(
          { companyId: context.companyId, pendingSends },
          "live event dropped: per-socket send queue is saturated",
        );
        return;
      }
      pendingSends += 1;
      // The transcript decision is async, so ordering is preserved explicitly:
      // each event is chained onto the previous one rather than racing it. A
      // live log stream that arrived out of order would be worse than useless.
      sendChain = sendChain
        .then(async () => {
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          const projected = await projectForSubscriber(event);
          if (closed || socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify(projected));
        })
        .catch((err) => {
          // Fail closed: drop this event rather than fall back to the
          // unprojected one. The gate itself already fails closed on an
          // authorization error, so reaching here means send/serialization
          // failed, and the socket's own error handler will take it from there.
          logger.warn({ err, companyId: context.companyId }, "failed to deliver live event");
        })
        .finally(() => {
          pendingSends -= 1;
        });
    });

    cleanupByClient.set(socket, unsubscribe);
    aliveByClient.set(socket, true);

    socket.on("pong", () => {
      aliveByClient.set(socket, true);
    });

    socket.on("close", () => {
      // PEN-3895: release the send chain with the subscription, not after it.
      // `sendChain` is per-socket state and was the one piece of it that
      // outlived the socket: the tail promise keeps the whole resolved chain,
      // and every event payload still referenced by a queued continuation,
      // reachable for as long as this closure is. An in-flight continuation
      // cannot be cancelled, but the `closed` latch makes the survivor a no-op
      // instead of a projection and a send on a dead socket.
      //
      // `pendingSends` is deliberately NOT reset: the queued `.finally` handlers
      // still run and decrement it, and zeroing it here would drive the counter
      // negative. After `cleanup()` no new events can enter, so its value no
      // longer gates anything.
      closed = true;
      sendChain = Promise.resolve();
      const cleanup = cleanupByClient.get(socket);
      if (cleanup) cleanup();
      cleanupByClient.delete(socket);
      aliveByClient.delete(socket);
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, companyId: context.companyId }, "live websocket client error");
    });
  });

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

  server.on("upgrade", (req, socket, head) => {
    if ((req as IncomingMessageWithContext).paperclipWebSocketHandled) {
      return;
    }

    const onRawSocketError = (err: Error) => {
      logger.warn({ err, path: req.url }, "live websocket upgrade socket error");
    };
    const cleanupRawSocketListeners = () => {
      socket.off("error", onRawSocketError);
      socket.off("close", cleanupRawSocketListeners);
    };

    socket.on("error", onRawSocketError);
    socket.once("close", cleanupRawSocketListeners);

    if (!req.url) {
      rejectUpgrade(socket, "400 Bad Request", "missing url");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const companyId = parseCompanyId(url.pathname);
    if (!companyId) {
      closeUpgradeSocket(socket);
      return;
    }

    void authorizeUpgrade(db, req, companyId, url, {
      deploymentMode: opts.deploymentMode,
      resolveSessionFromHeaders: opts.resolveSessionFromHeaders,
    })
      .then((context) => {
        if (!context) {
          rejectUpgrade(socket, "403 Forbidden", "forbidden");
          return;
        }

        if (!isWritableUpgradeSocket(socket)) {
          cleanupRawSocketListeners();
          return;
        }

        const reqWithContext = req as IncomingMessageWithContext;
        reqWithContext.paperclipUpgradeContext = context;

        cleanupRawSocketListeners();
        wss.handleUpgrade(req, socket, head, (ws: WsSocket) => {
          wss.emit("connection", ws, reqWithContext);
        });
      })
      .catch((err) => {
        logger.error({ err, path: req.url }, "failed websocket upgrade authorization");
        rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
      });
  });

  return wss;
}
