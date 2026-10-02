import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  liveEventCarriesTranscriptContent,
  withholdLiveEventTranscriptContent,
} from "../redaction.js";
import { decideRunTranscriptRead } from "../routes/authz.js";
import { accessService } from "../services/access.js";
import { logger } from "../middleware/logger.js";

/**
 * The identity a live-events subscriber connected with, as resolved by
 * `authorizeUpgrade`. Deliberately the same three fields the WebSocket upgrade
 * already produces, so this module cannot disagree with what was authenticated.
 */
export interface LiveEventSubscriberContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
  /**
   * The subscriber's membership role in the subscribed company, for a board
   * actor resolved at upgrade. Carried because `decideRunTranscriptRead` scopes
   * its human short-circuit to operator-grade roles — without it every board
   * socket would be decided as a role-less member and lose transcript content
   * that the REST twin still returns.
   */
  membershipRole?: string | null;
  /**
   * The actor source the upgrade authenticated this board subscriber with, in
   * the REST vocabulary. Carried rather than synthesized because
   * `decideRunTranscriptRead` keys on it — `cloud_tenant` is refused the
   * operator short-circuit outright — and a hardcoded `"session"` would erase
   * that distinction before the gate could see it, so the WS gate would answer
   * a question its REST twin does not (Ally review 5381822720).
   *
   * No upgrade path produces `cloud_tenant` today: `authorizeUpgrade` admits a
   * board only via the `local_trusted` branch or a better-auth session, and the
   * cloud-tenant actor is built from trusted headers on the REST middleware
   * only. This field exists so that if such a path is ever added, the gate
   * narrows with it instead of silently admitting it.
   */
  actorSource?: "local_implicit" | "session" | "cloud_tenant";
  /**
   * True for the `local_trusted` board, which has no membership row to carry.
   * Maps onto the `local_implicit` actor source the REST paths use for exactly
   * the same caller.
   */
  trustedLocal?: boolean;
}

type RunTranscriptDecider = Parameters<typeof decideRunTranscriptRead>[1];
type MembershipReader = () => Promise<{ membershipRole: string | null; status: string } | null>;

/**
 * How long one allow/deny decision may be reused on a socket.
 *
 * The REST twin's cache is per request, so it cannot go stale. A socket's
 * cannot have that property — it is long-lived by design — so the staleness is
 * bounded in time instead. 30s is short enough that a revoked grant, a removed
 * manager edge, or an agent moved out of a low-trust boundary stops the stream
 * promptly, and long enough that a busy company costs ~2 decisions per minute
 * per owning agent rather than one per event (Ally review 5375217878).
 */
const DECISION_TTL_MS = 30_000;

/**
 * `decideRunTranscriptRead` reads exactly two things off the request — the
 * actor, and (through `hasCompanyAccess`) the actor's company scope. The live
 * socket has no Express request, so we synthesize the minimum surface rather
 * than either duplicating the decision here or widening the decider's signature
 * across the REST paths that already carry it.
 *
 * Duplicating it is the failure this whole change is about: PEN-2777 was one
 * gate existing on one sibling path and not the other. A second definition for
 * the push path would recreate that with extra steps.
 *
 * The actor is built from what the upgrade already verified, not from anything
 * client-supplied: the agent branch is reached only after the bearer token
 * matched an unrevoked `agentApiKeys` row whose `companyId` equals the
 * subscribed company, and the board branch only after an instance-admin role or
 * an active company membership was confirmed.
 */
function syntheticRequest(context: LiveEventSubscriberContext): Request {
  const actor =
    context.actorType === "agent"
      ? {
          type: "agent" as const,
          agentId: context.actorId,
          companyId: context.companyId,
          source: "agent_key" as const,
        }
      : {
          type: "board" as const,
          userId: context.actorId,
          companyIds: [context.companyId],
          // The role the upgrade read off `company_memberships`, in the shape
          // the REST actor carries it, so the operator short-circuit asks one
          // question on both paths. Omitted entirely for the trusted local
          // board, which has no membership row — `local_implicit` is what the
          // REST middleware calls that same caller.
          memberships: context.trustedLocal
            ? undefined
            : [
                {
                  companyId: context.companyId,
                  membershipRole: context.membershipRole ?? null,
                  status: "active",
                },
              ],
          // The source the upgrade actually authenticated with, not a
          // hardcoded one — the operator short-circuit keys on it, so
          // synthesizing a value here would make the WS gate ask a different
          // question than the REST twin (see `actorSource`).
          source: context.trustedLocal
            ? ("local_implicit" as const)
            : (context.actorSource ?? ("session" as const)),
        };
  return { actor } as unknown as Request;
}

/**
 * Per-subscriber transcript gate for the live-event fan-out (PEN-3142).
 *
 * Returns a projector: give it a published `LiveEvent`, get back the event this
 * particular subscriber is entitled to see. Run STATE is never touched — the
 * event is always delivered, and only transcript-bearing keys are withheld, so
 * a peer can still watch that a run is producing output without reading it.
 *
 * MEMOIZED PER OWNING AGENT, which is the resource the decision is actually
 * scoped to, and expired after `DECISION_TTL_MS`. A socket streaming a busy
 * company sees thousands of events from a handful of agents; without the memo
 * this would be one authorization round-trip per event.
 *
 * The TTL is the difference between this and the REST list gate, which is safe
 * because its cache cannot outlive one request (`routes/authz.ts`). A socket's
 * lifetime is unbounded — `live-events-ws.ts` keeps it alive with ping/pong —
 * so an un-expiring allow would keep streaming `chunk` / `message` / `payload`
 * / `lastAssistantSnippet` after a revoked grant, a reporting-line change, or a
 * move out of a low-trust boundary, for as long as the client stayed connected.
 * That is the fail-OPEN direction, so the reuse window is bounded in time
 * rather than by the connection (Ally review 5375217878).
 *
 * Re-deciding alone does not bound a board operator. The operator
 * short-circuit in `decideRunTranscriptRead` answers from the actor's
 * membership role and returns before the decider runs, so re-deciding against
 * the upgrade-time role would re-derive the same allow for the life of the
 * socket — a board user demoted to `viewer`, or deactivated, would keep the
 * stream. The membership row is therefore re-read once the TTL has passed, and
 * a board decision is stamped with the age of the role it was made from, so the
 * role arm is bounded by the same window as the decider arm (Ally review
 * 5386746244). The trusted local board has no membership row and is not
 * re-read.
 *
 * The entry is stamped when the decision STARTS, not when it resolves, so a
 * slow authorizer shortens the window rather than extending it.
 */
export function createLiveEventTranscriptGate(
  db: Db,
  context: LiveEventSubscriberContext,
  deps?: { access?: RunTranscriptDecider; now?: () => number; ttlMs?: number; readMembership?: MembershipReader },
): (event: LiveEvent) => Promise<LiveEvent> {
  const access = deps?.access ?? (accessService(db) as RunTranscriptDecider);
  const now = deps?.now ?? (() => Date.now());
  const ttlMs = deps?.ttlMs ?? DECISION_TTL_MS;
  const readMembership =
    deps?.readMembership ?? (() => accessService(db).getMembership(context.companyId, "user", context.actorId));
  const rereadsMembership = context.actorType === "board" && !context.trustedLocal;
  // The upgrade read the membership just before this gate was built, so the
  // first window reuses it rather than reading it twice.
  let actor = { readAt: now(), req: Promise.resolve(syntheticRequest(context)) };
  const actorAt = (startedAt: number) => {
    if (rereadsMembership && startedAt - actor.readAt >= ttlMs) {
      actor = {
        readAt: startedAt,
        req: Promise.resolve()
          .then(readMembership)
          .then((membership) =>
            syntheticRequest({
              ...context,
              membershipRole: membership?.status === "active" ? membership.membershipRole : null,
            }),
          ),
      };
    }
    return actor;
  };
  const cache = new Map<string, { decidedAt: number; allowed: Promise<boolean> }>();

  const canRead = (agentId: string): Promise<boolean> => {
    const startedAt = now();
    const cached = cache.get(agentId);
    if (cached && startedAt - cached.decidedAt < ttlMs) return cached.allowed;
    const { readAt, req } = actorAt(startedAt);
    const pending = req
      .then((request) => decideRunTranscriptRead(request, access, { companyId: context.companyId, agentId }))
      .then((outcome) => outcome.allowed)
      // Fail closed. An authorization error — or a failed membership re-read —
      // must not become a transcript read; the subscriber still receives the
      // event, just without the content.
      //
      // Logged for the reason the REST twin gives at `routes/authz.ts`: a
      // broken authorizer that failed silently would be indistinguishable from
      // an ordinary unentitled read, on the one path that exists to make
      // transcript access decidable. Fail closed AND say so — and say so here
      // too, so the posture really is local to both gates rather than inferable
      // only from the REST one.
      .catch((error) => {
        logger.error(
          { err: error, companyId: context.companyId, agentId },
          "live-event transcript read decision failed; withholding",
        );
        return false;
      });
    // A board decision is no fresher than the role it was made from: stamping
    // it with `startedAt` would let a decision started late in a role window
    // outlive that window by up to a further TTL.
    cache.set(agentId, { decidedAt: rereadsMembership ? readAt : startedAt, allowed: pending });
    // Drop entries that can no longer be reused. The map is bounded by the
    // company's agent count rather than by event volume, so this is small — but
    // the entries are timestamped now, so evicting is nearly free and keeps a
    // long-lived socket in a large company from retaining one entry per owning
    // agent ever seen (Ally review 5381822720).
    for (const [cachedKey, entry] of cache) {
      if (cachedKey !== agentId && startedAt - entry.decidedAt >= ttlMs) cache.delete(cachedKey);
    }
    return pending;
  };

  return async (event: LiveEvent): Promise<LiveEvent> => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (!liveEventCarriesTranscriptContent(payload)) return event;

    // The owning agent is the resource the decision is scoped to. A
    // transcript-bearing payload that cannot name its owner is withheld rather
    // than guessed at — same posture as the workspace-operation path, which is
    // deliberately tighter than the decider on an unresolved owner. `canRead`
    // therefore takes a non-null owner: withholding here is the only outcome an
    // unowned payload has, so no cache entry can stand for one (Ally review
    // 5391609907).
    const rawAgentId = payload.agentId;
    const agentId = typeof rawAgentId === "string" && rawAgentId.length > 0 ? rawAgentId : null;
    if (agentId !== null && (await canRead(agentId))) return event;

    return { ...event, payload: withholdLiveEventTranscriptContent(payload) };
  };
}
