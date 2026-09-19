import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  liveEventCarriesTranscriptContent,
  withholdLiveEventTranscriptContent,
} from "../redaction.js";
import { decideRunTranscriptRead } from "../routes/authz.js";
import { accessService } from "../services/access.js";

/**
 * The identity a live-events subscriber connected with, as resolved by
 * `authorizeUpgrade`. Deliberately the same three fields the WebSocket upgrade
 * already produces, so this module cannot disagree with what was authenticated.
 */
export interface LiveEventSubscriberContext {
  companyId: string;
  actorType: "board" | "agent";
  actorId: string;
}

type RunTranscriptDecider = Parameters<typeof decideRunTranscriptRead>[1];

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
          source: "session" as const,
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
 * MEMOIZED OVER THE SOCKET'S LIFETIME, keyed on the run's OWNING AGENT, which
 * is the resource the decision is actually scoped to. A socket streaming a busy
 * company sees thousands of events from a handful of agents; without the memo
 * this would be one authorization round-trip per event.
 *
 * The staleness that buys is bounded and deliberate: a grant or reporting-line
 * change mid-connection is not picked up until the socket reconnects. That is
 * the same trade the REST list route makes per request, one connection long
 * instead of one request long, and it only ever fails CLOSED for a peer who was
 * denied at connect time — a revoked grant keeps streaming until reconnect,
 * which is why this is scoped to a live socket rather than cached globally.
 */
export function createLiveEventTranscriptGate(
  db: Db,
  context: LiveEventSubscriberContext,
  deps?: { access?: RunTranscriptDecider },
): (event: LiveEvent) => Promise<LiveEvent> {
  const access = deps?.access ?? (accessService(db) as RunTranscriptDecider);
  const req = syntheticRequest(context);
  const cache = new Map<string, Promise<boolean>>();

  const canRead = (agentId: string | null): Promise<boolean> => {
    const key = agentId ?? "";
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = decideRunTranscriptRead(req, access, {
      companyId: context.companyId,
      agentId,
    })
      .then((outcome) => outcome.allowed)
      // Fail closed. An authorization error must not become a transcript read;
      // the subscriber still receives the event, just without the content.
      .catch(() => false);
    cache.set(key, pending);
    return pending;
  };

  return async (event: LiveEvent): Promise<LiveEvent> => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (!liveEventCarriesTranscriptContent(payload)) return event;

    // The owning agent is the resource the decision is scoped to. A
    // transcript-bearing payload that cannot name its owner is withheld rather
    // than guessed at — same posture as the workspace-operation path, which is
    // deliberately tighter than the decider on an unresolved owner.
    const rawAgentId = payload.agentId;
    const agentId = typeof rawAgentId === "string" && rawAgentId.length > 0 ? rawAgentId : null;
    if (agentId !== null && (await canRead(agentId))) return event;

    return { ...event, payload: withholdLiveEventTranscriptContent(payload) };
  };
}
