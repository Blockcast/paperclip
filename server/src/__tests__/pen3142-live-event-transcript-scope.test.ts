import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-3142 — the live-event PUSH channel, closed alongside the two REST pull
 * paths (Ally's Critical finding on PR #1741 at head `7d859154`).
 *
 * `subscribeCompanyLiveEvents` fans every company event out to every subscriber,
 * and three published types carry the same transcript content `/log` and
 * `/events` withdraw. Narrowing only the pull paths would have left the
 * highest-fidelity copy of the material on an ungated socket — the PEN-2777
 * split-sibling failure, one sibling further out.
 *
 * Two layers are pinned here deliberately:
 *
 *  - the gate in isolation, where each arm can be exercised precisely; and
 *  - the real `setupLiveEventsWebSocketServer` handler fed by the real
 *    `publishLiveEvent`, because a correct gate that is not actually on the
 *    traffic path protects nothing. The second layer is the one Ally asked for
 *    by name: "publishes a canary through `publishLiveEvent` and asserts it
 *    never reaches a non-owning agent socket."
 *
 * `denies-nothing-extra` is the counterweight: run STATE must stay
 * company-readable, and the PEN-3140 decision calls narrowing it wrong.
 */

const CANARY = "SUPER-SECRET-TRANSCRIPT-CANARY-a1b2c3";

const companyId = "11111111-1111-4111-8111-111111111111";
const runOwnerAgentId = "22222222-2222-4222-8222-222222222222";
const peerAgentId = "33333333-3333-4333-8333-333333333333";
const boardUserId = "44444444-4444-4444-8444-444444444444";

const mockDecide = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({ decide: mockDecide }),
}));

/** Allow only the owning agent; everyone else is an unentitled peer. */
function allowOnlyOwner() {
  mockDecide.mockImplementation(async (input: { actor: { agentId?: string } }) => ({
    allowed: input.actor.agentId === runOwnerAgentId,
    reason: input.actor.agentId === runOwnerAgentId ? "allow_self" : "deny_missing_grant",
    explanation: "test",
  }));
}

function logEvent() {
  return {
    id: 1,
    companyId,
    type: "heartbeat.run.log" as const,
    createdAt: new Date().toISOString(),
    payload: { runId: "run-1", agentId: runOwnerAgentId, seq: 1, stream: "stdout", chunk: CANARY, truncated: false },
  };
}

function runEventEvent() {
  return {
    id: 2,
    companyId,
    type: "heartbeat.run.event" as const,
    createdAt: new Date().toISOString(),
    payload: {
      runId: "run-1",
      agentId: runOwnerAgentId,
      seq: 2,
      eventType: "assistant",
      currentToolName: "Bash",
      message: CANARY,
      lastAssistantSnippet: CANARY,
      payload: { text: CANARY },
    },
  };
}

function progressEvent() {
  return {
    id: 3,
    companyId,
    type: "heartbeat.run.progress" as const,
    createdAt: new Date().toISOString(),
    payload: {
      runId: "run-1",
      agentId: runOwnerAgentId,
      phase: "running",
      currentToolName: "Read",
      message: CANARY,
      lastAssistantSnippet: CANARY,
    },
  };
}

const transcriptCanaries = [
  ["heartbeat.run.log", logEvent],
  ["heartbeat.run.event", runEventEvent],
  ["heartbeat.run.progress", progressEvent],
] as const;

describe("PEN-3142 live-event transcript gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowOnlyOwner();
  });

  describe("transcript content", () => {
    it.each(transcriptCanaries)(
      "withholds %s content from an unentitled company peer",
      async (_type, build) => {
        const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
        const project = createLiveEventTranscriptGate({} as never, {
          companyId,
          actorType: "agent",
          actorId: peerAgentId,
        });

        const projected = await project(build() as never);

        expect(JSON.stringify(projected)).not.toContain(CANARY);
      },
    );

    it.each(transcriptCanaries)("delivers %s content to the owning agent", async (_type, build) => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      });

      const projected = await project(build() as never);

      expect(JSON.stringify(projected)).toContain(CANARY);
    });

    it("nulls exactly the four transcript keys and marks them withheld", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      const projected = (await project(runEventEvent() as never)) as unknown as {
        payload: Record<string, unknown> & { withheldFields: string[] };
      };

      expect(projected.payload.message).toBeNull();
      expect(projected.payload.payload).toBeNull();
      expect(projected.payload.lastAssistantSnippet).toBeNull();
      expect([...projected.payload.withheldFields].sort()).toEqual([
        "lastAssistantSnippet",
        "message",
        "payload",
      ]);
    });

    it("keeps currentToolName, matching the REST projection that recomputes status from it", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      const projected = (await project(runEventEvent() as never)) as unknown as {
        payload: Record<string, unknown>;
      };

      // Run STATE. The `/events` projection recomputes `currentStatusMessage`
      // from this rather than nulling it, so withholding it here would
      // contradict the decision this gate enforces.
      expect(projected.payload.currentToolName).toBe("Bash");
      expect(projected.payload.runId).toBe("run-1");
      expect(projected.payload.seq).toBe(2);
    });
  });

  describe("denies nothing extra — run state stays company-readable", () => {
    const stateOnly = [
      ["heartbeat.run.status", { runId: "run-1", agentId: runOwnerAgentId, status: "failed", error: "boom: exit 1", errorCode: "E_FAIL" }],
      ["heartbeat.run.queued", { runId: "run-1", agentId: runOwnerAgentId, invocationSource: "assignment", triggerDetail: "system" }],
      ["agent.status", { agentId: runOwnerAgentId, status: "idle", outcome: "succeeded" }],
      ["activity.logged", { actorType: "agent", actorId: runOwnerAgentId, action: "issue.updated", details: { label: "some detail" } }],
      ["external_object.updated", { objectId: "obj-1", liveness: "live" }],
    ] as const;

    it.each(stateOnly)("passes %s through untouched for an unentitled peer", async (type, payload) => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      const event = { id: 9, companyId, type, createdAt: new Date().toISOString(), payload };
      const projected = await project(event as never);

      // Identity, not merely equivalent: a state event must not even be copied
      // through the projection, so error text and the retry edge cannot drift.
      expect(projected).toBe(event);
      expect(mockDecide).not.toHaveBeenCalled();
    });
  });

  describe("operators and memoization", () => {
    it("delivers transcript content to a human board subscriber", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "board",
        actorId: boardUserId,
      });

      const projected = await project(logEvent() as never);

      expect(JSON.stringify(projected)).toContain(CANARY);
      // Board is decided without the authorization service, same as the REST
      // decider — not by a grant lookup that could deny an operator.
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("decides once per owning agent for the life of the socket", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      for (let i = 0; i < 25; i += 1) await project(logEvent() as never);
      const otherOwner = logEvent();
      otherOwner.payload.agentId = "55555555-5555-4555-8555-555555555555";
      await project(otherOwner as never);

      // 26 transcript events, 2 distinct owning agents.
      expect(mockDecide).toHaveBeenCalledTimes(2);
    });
  });

  describe("fails closed", () => {
    it("withholds when the payload cannot name its owning agent", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      });

      const orphan = logEvent();
      (orphan.payload as Record<string, unknown>).agentId = null;
      const projected = await project(orphan as never);

      expect(JSON.stringify(projected)).not.toContain(CANARY);
      // Never guessed at: an unresolvable owner is not routed to the decider,
      // matching the workspace-operation path's tighter null-owner posture.
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("withholds when the authorization service throws", async () => {
      mockDecide.mockRejectedValue(new Error("authz unavailable"));
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      });

      const projected = await project(logEvent() as never);

      expect(JSON.stringify(projected)).not.toContain(CANARY);
    });
  });
});

/**
 * The wiring proof. Everything above tests the gate; this tests that the socket
 * actually runs events through it, driving the real handler with the real
 * publish path.
 */
describe("PEN-3142 live-event transcript scope — WebSocket fan-out", () => {
  class FakeClientSocket extends EventEmitter {
    readyState = 1; // WebSocket.OPEN
    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    ping() {}
    terminate() {}
    close() {}
  }

  async function flush() {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async function connectSubscriber(actorType: "board" | "agent", actorId: string) {
    const { setupLiveEventsWebSocketServer } = await import("../realtime/live-events-ws.js");
    const server = new EventEmitter();
    const wss = setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
    });
    const socket = new FakeClientSocket();
    const req = { headers: {}, paperclipUpgradeContext: { companyId, actorType, actorId } } as unknown as IncomingMessage;
    wss.emit("connection", socket as never, req);
    return socket;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    allowOnlyOwner();
  });

  it("never delivers a published transcript canary to a non-owning agent socket", async () => {
    const { publishLiveEvent } = await import("../services/live-events.js");
    const peerSocket = await connectSubscriber("agent", peerAgentId);

    for (const [, build] of transcriptCanaries) {
      const event = build();
      publishLiveEvent({ companyId, type: event.type, payload: event.payload as never });
    }
    await flush();

    expect(peerSocket.sent).toHaveLength(3);
    expect(peerSocket.sent.join("\n")).not.toContain(CANARY);
  });

  it("delivers the same canaries in full to the owning agent's socket", async () => {
    const { publishLiveEvent } = await import("../services/live-events.js");
    const ownerSocket = await connectSubscriber("agent", runOwnerAgentId);

    for (const [, build] of transcriptCanaries) {
      const event = build();
      publishLiveEvent({ companyId, type: event.type, payload: event.payload as never });
    }
    await flush();

    expect(ownerSocket.sent).toHaveLength(3);
    for (const frame of ownerSocket.sent) expect(frame).toContain(CANARY);
  });

  it("still tells an unentitled peer that the run is producing output", async () => {
    const { publishLiveEvent } = await import("../services/live-events.js");
    const peerSocket = await connectSubscriber("agent", peerAgentId);

    const event = logEvent();
    publishLiveEvent({ companyId, type: event.type, payload: event.payload as never });
    await flush();

    // Withheld, not dropped — run state stays company-readable.
    const frame = JSON.parse(peerSocket.sent[0]) as { type: string; payload: Record<string, unknown> };
    expect(frame.type).toBe("heartbeat.run.log");
    expect(frame.payload.runId).toBe("run-1");
    expect(frame.payload.seq).toBe(1);
    expect(frame.payload.chunk).toBeNull();
    expect(frame.payload.withheldFields).toEqual(["chunk"]);
  });

  it("preserves event order across the async gate", async () => {
    const { publishLiveEvent } = await import("../services/live-events.js");
    const ownerSocket = await connectSubscriber("agent", runOwnerAgentId);

    for (let seq = 0; seq < 12; seq += 1) {
      publishLiveEvent({
        companyId,
        type: "heartbeat.run.log",
        payload: { runId: "run-1", agentId: runOwnerAgentId, seq, stream: "stdout", chunk: `chunk-${seq}` } as never,
      });
    }
    await flush();

    const seqs = ownerSocket.sent.map((frame) => (JSON.parse(frame) as { payload: { seq: number } }).payload.seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
