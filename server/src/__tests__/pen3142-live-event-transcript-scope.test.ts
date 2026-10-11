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
/**
 * PEN-3148: the access audit this path gained. Mocked rather than driven
 * against a database because every case here builds the gate with a stub `db`
 * — the assertion is the row's SHAPE and its CARDINALITY, which is where the
 * streaming path differs from its REST twins.
 */
const mockLogActivity = vi.hoisted(() => vi.fn());
/**
 * What `logActivity({ deferPublish: true })` hands back. Held as a spy so the
 * suite can assert this site never calls it: publishing from inside the
 * fan-out would feed the fan-out (see the gate's `defaultTranscriptStreamAuditor`).
 */
const mockPublishAudit = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
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
    mockLogActivity.mockResolvedValue(mockPublishAudit);
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
        actorSource: "session",
        membershipRole: "owner",
      });

      const projected = await project(logEvent() as never);

      expect(JSON.stringify(projected)).toContain(CANARY);
      // Board is decided without the authorization service, same as the REST
      // decider — not by a grant lookup that could deny an operator.
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("delivers transcript content to the trusted local board, which has no membership row", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "board",
        actorId: "board",
        trustedLocal: true,
      });

      // `local_trusted` mode authorizes the upgrade with no session and no
      // membership; REST calls it `local_implicit` and allows it. A socket that
      // decided it as a role-less member would withhold from the local board.
      expect(JSON.stringify(await project(logEvent() as never))).toContain(CANARY);
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("withholds from a viewer-role board subscriber who holds no grant", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "board",
        actorId: boardUserId,
        actorSource: "session",
        membershipRole: "viewer",
      });

      const projected = await project(logEvent() as never);

      // The push path has to draw the human line in the same place the pull
      // paths do, or the socket becomes the way around the gate.
      expect(JSON.stringify(projected)).not.toContain(CANARY);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
      }));
    });

    /**
     * Ally review 5381822720 (Important #1), socket half. The context used to
     * hardcode `source: "session"` for every non-trusted-local board, which
     * erased the distinction the REST gate decides on — so a cloud-tenant
     * subscriber would have been modelled as a session actor and matched the
     * operator set on its `owner` role.
     *
     * No upgrade path produces `cloud_tenant` today (`authorizeUpgrade` admits
     * a board only via `local_trusted` or a better-auth session), so this pins
     * the PARITY rather than a live hole: the gate's docblock claims the socket
     * asks the REST twin's question, and this is what makes that true if such a
     * path is ever added.
     */
    it("withholds from a cloud-tenant board subscriber despite an owner role", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "board",
        actorId: boardUserId,
        actorSource: "cloud_tenant",
        membershipRole: "owner",
      });

      const projected = await project(logEvent() as never);

      expect(JSON.stringify(projected)).not.toContain(CANARY);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
      }));
    });

    it("delivers transcript content to a member-role board subscriber, which normalizes to operator", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "board",
        actorId: boardUserId,
        actorSource: "session",
        membershipRole: "member",
      });

      // `normalizeHumanRole` folds `member` into `operator` everywhere else in
      // the codebase; the gate agrees rather than denying one role name that
      // every other consumer treats as an operator (Ally review 5381822720).
      expect(JSON.stringify(await project(logEvent() as never))).toContain(CANARY);
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("decides once per owning agent inside the TTL window", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      let clock = 1_000;
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "agent", actorId: peerAgentId },
        { now: () => clock },
      );

      for (let i = 0; i < 25; i += 1) {
        clock += 100;
        await project(logEvent() as never);
      }
      const otherOwner = logEvent();
      otherOwner.payload.agentId = "55555555-5555-4555-8555-555555555555";
      await project(otherOwner as never);

      // 26 transcript events spanning 2.5s, 2 distinct owning agents.
      expect(mockDecide).toHaveBeenCalledTimes(2);
    });

    it("re-decides after the TTL, so a revoked grant stops the stream", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      mockDecide.mockResolvedValue({ allowed: true, reason: "allow_grant", explanation: "granted" });
      let clock = 1_000;
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "agent", actorId: peerAgentId },
        { now: () => clock, ttlMs: 30_000 },
      );

      expect(JSON.stringify(await project(logEvent() as never))).toContain(CANARY);
      // Revoked mid-connection. A socket is kept alive indefinitely by the
      // ping/pong keepalive, so a cache with no expiry would stream transcript
      // content for the life of the client — the fail-OPEN direction.
      mockDecide.mockResolvedValue({
        allowed: false,
        reason: "deny_missing_grant",
        explanation: "revoked",
      });

      clock += 29_999;
      expect(JSON.stringify(await project(logEvent() as never))).toContain(CANARY);
      expect(mockDecide).toHaveBeenCalledTimes(1);

      clock += 2;
      expect(JSON.stringify(await project(logEvent() as never))).not.toContain(CANARY);
      expect(mockDecide).toHaveBeenCalledTimes(2);
    });

    /**
     * Ally review 5386746244 (Important #2). The case above drives the decider
     * arm only. A board operator is answered by the short-circuit, which never
     * reaches the decider, so re-deciding against the upgrade-time role would
     * re-derive the same allow for the life of the socket. The membership is
     * re-read once the TTL expires instead.
     */
    it("re-reads the membership after the TTL, so a board admin demoted to viewer stops the stream", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      mockDecide.mockResolvedValue({ allowed: false, reason: "deny_missing_grant", explanation: "viewer" });
      const readMembership = vi.fn().mockResolvedValue({ membershipRole: "viewer", status: "active" });
      let clock = 1_000;
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "board", actorId: boardUserId, actorSource: "session", membershipRole: "admin" },
        { now: () => clock, ttlMs: 30_000, readMembership },
      );
      const otherOwnerEvent = () => {
        const event = logEvent();
        event.payload.agentId = "55555555-5555-4555-8555-555555555555";
        return event;
      };

      expect(JSON.stringify(await project(logEvent() as never))).toContain(CANARY);
      // Demoted admin -> viewer mid-connection. Inside the window the
      // upgrade-time role still holds, including for an owner first seen late
      // in that window.
      clock += 29_999;
      expect(JSON.stringify(await project(otherOwnerEvent() as never))).toContain(CANARY);
      expect(readMembership).not.toHaveBeenCalled();

      clock += 2;
      expect(JSON.stringify(await project(logEvent() as never))).not.toContain(CANARY);
      // The late decision expires with the role it was made from, not a full
      // TTL after it started.
      expect(JSON.stringify(await project(otherOwnerEvent() as never))).not.toContain(CANARY);
      expect(readMembership).toHaveBeenCalledTimes(1);
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ action: "runs:read_transcript" }));
    });

    it("re-reads the membership after the TTL, so a deactivated board operator stops the stream", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      mockDecide.mockResolvedValue({ allowed: false, reason: "deny_missing_grant", explanation: "inactive" });
      const readMembership = vi.fn().mockResolvedValue({ membershipRole: "admin", status: "suspended" });
      let clock = 1_000;
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "board", actorId: boardUserId, actorSource: "session", membershipRole: "admin" },
        { now: () => clock, ttlMs: 30_000, readMembership },
      );

      expect(JSON.stringify(await project(logEvent() as never))).toContain(CANARY);
      clock += 30_001;
      expect(JSON.stringify(await project(logEvent() as never))).not.toContain(CANARY);
    });

    it("stamps the cache entry when the decision STARTS, not when it resolves", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      let clock = 1_000;
      let release: (value: unknown) => void = () => {};
      mockDecide.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "agent", actorId: peerAgentId },
        { now: () => clock, ttlMs: 30_000 },
      );

      const first = project(logEvent() as never);
      // A slow authorizer must shorten the reuse window, not extend it: stamping
      // on resolve would let a 20s decision be reused for 50s.
      clock += 20_000;
      release({ allowed: false, reason: "deny_missing_grant", explanation: "slow" });
      await first;

      clock += 10_001;
      await project(logEvent() as never);
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

  /**
   * PEN-3148 Done-when 4. The socket was the FOURTH transcript surface and the
   * only one still writing no access record at all, so "who read this
   * transcript" had no answer for the highest-fidelity copy of the material.
   *
   * What is pinned here that the REST twins do not have to pin:
   *
   *  - CARDINALITY. One row per DECISION, reused for the whole TTL window. A
   *    per-event row would be thousands per run and would make the row count
   *    read as a count of reads, which it is not.
   *  - NON-PUBLICATION. This audit site is itself on the live-event fan-out, so
   *    a published `activity.logged` would feed the channel it is auditing.
   */
  describe("access audit", () => {
    const auditCalls = () =>
      mockLogActivity.mock.calls.filter(
        (call) => (call[1] as { action?: string } | undefined)?.action === "heartbeat.run_events_streamed",
      );

    it("records a denied read against the OWNING agent, with the decider's reason", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      await project(logEvent() as never);

      expect(auditCalls()).toHaveLength(1);
      const [, input, options] = auditCalls()[0] as [unknown, Record<string, unknown>, unknown];
      expect(input).toMatchObject({
        companyId,
        actorType: "agent",
        // The reader is the actor...
        actorId: peerAgentId,
        agentId: peerAgentId,
        // ...and the run's owner is the subject the decision was about.
        entityType: "agent",
        entityId: runOwnerAgentId,
        details: {
          result: "denied",
          reason: "deny_missing_grant",
          ownerAgentId: runOwnerAgentId,
          transport: "websocket",
        },
      });
      expect(options).toEqual({ deferPublish: true });
    });

    it("records an allowed read for the owning agent", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      });

      await project(logEvent() as never);

      expect(auditCalls()).toHaveLength(1);
      expect((auditCalls()[0] as [unknown, Record<string, unknown>])[1]).toMatchObject({
        details: { result: "allowed", reason: "allow_self", ownerAgentId: runOwnerAgentId },
      });
    });

    it("writes ONE row per decision, not one per event", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      for (const [, build] of transcriptCanaries) await project(build() as never);

      // Three transcript-bearing events, one owning agent, one decision.
      expect(auditCalls()).toHaveLength(1);
    });

    it("writes a fresh row once the decision window has expired", async () => {
      let clock = 0;
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "agent", actorId: peerAgentId },
        { now: () => clock, ttlMs: 1000 },
      );

      await project(logEvent() as never);
      clock = 1001;
      await project(logEvent() as never);

      expect(auditCalls()).toHaveLength(2);
    });

    it("records the unresolved-owner withhold, with a null owner and a gate-local reason", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      });

      const orphan = logEvent();
      (orphan.payload as Record<string, unknown>).agentId = null;
      await project(orphan as never);

      expect(auditCalls()).toHaveLength(1);
      expect((auditCalls()[0] as [unknown, Record<string, unknown>])[1]).toMatchObject({
        entityId: "unresolved-owner",
        details: { result: "denied", reason: "withhold_unresolved_owner", ownerAgentId: null },
      });
    });

    it("records the board operator short-circuit, which carries no AuthorizationDecision", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "board",
        actorId: boardUserId,
        membershipRole: "admin",
      });

      await project(logEvent() as never);

      expect(auditCalls()).toHaveLength(1);
      expect((auditCalls()[0] as [unknown, Record<string, unknown>])[1]).toMatchObject({
        actorType: "user",
        actorId: boardUserId,
        agentId: null,
        details: { result: "allowed", reason: "allow_board_transcript_operator" },
      });
      // The short-circuit returns before the decider, so there is no
      // `AuthorizationDecision` to read a reason off — the row must not say
      // `null` where its REST twin would name a boundary.
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("never publishes the audit back onto the live-event channel it is auditing", async () => {
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: peerAgentId,
      });

      await project(logEvent() as never);

      expect(auditCalls()).toHaveLength(1);
      expect(mockPublishAudit).not.toHaveBeenCalled();
    });

    it("withholds when the audit cannot be written, rather than serving unaudited bytes", async () => {
      mockLogActivity.mockRejectedValue(new Error("activity log unavailable"));
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        // The OWNER, who is entitled. The withhold here is the audit failing,
        // not the decision — same posture as the REST twins, where an unguarded
        // `await logRunLogAccessAudit(...)` fails the response.
        actorId: runOwnerAgentId,
      });

      const projected = await project(logEvent() as never);

      expect(JSON.stringify(projected)).not.toContain(CANARY);
    });

    // Ally review 5473258762 (Important): the failed write used to be memoized
    // as a denial for the whole window, so an ENTITLED reader stayed withheld
    // for up to the TTL after the audit backend recovered. The REST twins fail
    // only the one request; the next one re-attempts. So must this.
    it("re-attempts the audit on the next event after a failed write, inside the same window", async () => {
      mockLogActivity.mockRejectedValueOnce(new Error("activity log unavailable"));
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const project = createLiveEventTranscriptGate(
        {} as never,
        { companyId, actorType: "agent", actorId: runOwnerAgentId },
        // A frozen clock: the second event is well inside the decision window.
        { now: () => 0, ttlMs: 30_000 },
      );

      const first = await project(logEvent() as never);
      const second = await project(logEvent() as never);

      expect(JSON.stringify(first)).not.toContain(CANARY);
      expect(JSON.stringify(second)).toContain(CANARY);
      expect(auditCalls()).toHaveLength(2);
      // ...and the recovered decision IS memoized: a third event writes no row.
      await project(logEvent() as never);
      expect(auditCalls()).toHaveLength(2);
    });

    it("logs a failed audit write apart from a failed decision", async () => {
      const { logger } = await import("../middleware/logger.js");
      const { createLiveEventTranscriptGate } = await import("../realtime/live-event-transcript-gate.js");
      const errorMessages = () => vi.mocked(logger.error).mock.calls.map((call) => String(call[1]));

      mockLogActivity.mockRejectedValueOnce(new Error("activity log unavailable"));
      await createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      })(logEvent() as never);
      expect(errorMessages()).toEqual([expect.stringMatching(/audit write failed/)]);

      vi.mocked(logger.error).mockClear();
      mockDecide.mockRejectedValueOnce(new Error("authz unavailable"));
      await createLiveEventTranscriptGate({} as never, {
        companyId,
        actorType: "agent",
        actorId: runOwnerAgentId,
      })(logEvent() as never);
      expect(errorMessages()).toEqual([expect.stringMatching(/decision failed/)]);
      expect(errorMessages()[0]).not.toMatch(/audit/);
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
    mockLogActivity.mockResolvedValue(mockPublishAudit);
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

  it("audits the withhold on the socket path, naming the run's owner", async () => {
    const { publishLiveEvent } = await import("../services/live-events.js");
    await connectSubscriber("agent", peerAgentId);

    const event = logEvent();
    publishLiveEvent({ companyId, type: event.type, payload: event.payload as never });
    await flush();

    // The wiring proof for PEN-3148 Done-when 4: the record is written by
    // traffic on the real socket, not only by calling the gate directly.
    const audits = mockLogActivity.mock.calls.filter(
      (call) => (call[1] as { action?: string } | undefined)?.action === "heartbeat.run_events_streamed",
    );
    expect(audits).toHaveLength(1);
    expect((audits[0] as [unknown, Record<string, unknown>])[1]).toMatchObject({
      actorId: peerAgentId,
      entityId: runOwnerAgentId,
      details: { result: "denied", ownerAgentId: runOwnerAgentId, transport: "websocket" },
    });
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

/**
 * Ally review 5449228335 (Critical): the socket half of the WS-vs-REST pair for
 * scope-restricted agent keys. The REST half is in
 * `pen3142-run-transcript-scope.test.ts`.
 *
 * Driven through the real upgrade, not a hand-built context, because the bug
 * was `authorizeUpgrade` discarding `scopeConfig` from the very row it had
 * selected — a test that supplies the context itself cannot see that.
 *
 * The decider stub mirrors `decideSkillTestAccess`'s default-deny (pinned
 * against the real service in `authorization-service.test.ts`) and otherwise
 * allows the owner, so the key's scope is the only thing that can withhold.
 */
describe("PEN-3142 live-event transcript scope — scoped agent keys", () => {
  class FakeClientSocket extends EventEmitter {
    readyState = 1;
    sent: string[] = [];
    send(data: string) {
      this.sent.push(data);
    }
    ping() {}
    terminate() {}
    close() {}
  }

  class FakeUpgradeSocket extends EventEmitter {
    destroyed = false;
    writable = true;
    end() {
      return this;
    }
    destroy() {
      this.destroyed = true;
      return this;
    }
  }

  const skillTestScope = { kind: "skill_test", issueId: "55555555-5555-4555-8555-555555555555" };

  /** Thenable stand-in for the two drizzle chains `authorizeUpgrade` runs on the key. */
  function keyDb(row: Record<string, unknown>) {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve([row]).then(resolve, reject),
    };
    for (const method of ["select", "from", "where", "update", "set"]) chain[method] = () => chain;
    return chain;
  }

  async function connectWithKey(scopeConfig: Record<string, unknown>) {
    const { setupLiveEventsWebSocketServer } = await import("../realtime/live-events-ws.js");
    const server = new EventEmitter();
    const db = keyDb({ id: "key-1", agentId: runOwnerAgentId, companyId, revokedAt: null, scopeConfig });
    const wss = setupLiveEventsWebSocketServer(server as never, db as never, { deploymentMode: "authenticated" });
    const client = new FakeClientSocket();
    vi.spyOn(wss as unknown as { handleUpgrade: (...args: unknown[]) => void }, "handleUpgrade")
      .mockImplementation((...args: unknown[]) => (args[3] as (ws: unknown) => void)(client));
    server.emit(
      "upgrade",
      { url: `/api/companies/${companyId}/events/ws`, headers: { authorization: "Bearer test-token" } },
      new FakeUpgradeSocket(),
      Buffer.alloc(0),
    );
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    return client;
  }

  async function publishCanaries(client: FakeClientSocket) {
    const { publishLiveEvent } = await import("../services/live-events.js");
    for (const [, build] of transcriptCanaries) {
      const event = build();
      publishLiveEvent({ companyId, type: event.type, payload: event.payload as never });
    }
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    return client.sent;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(mockPublishAudit);
    mockDecide.mockImplementation(async (input: { actor: { agentId?: string; keyScope?: { kind?: string } } }) =>
      input.actor.keyScope?.kind === "skill_test"
        ? { allowed: false, reason: "deny_scope", explanation: "Skill-test run token cannot use this API action." }
        : { allowed: input.actor.agentId === runOwnerAgentId, reason: "allow_self", explanation: "test" });
  });

  it("withholds the transcript from a skill_test-scoped key, as its REST twin does", async () => {
    const sent = await publishCanaries(await connectWithKey(skillTestScope));

    expect(sent).toHaveLength(3);
    expect(sent.join("\n")).not.toContain(CANARY);
    // The decider is handed the key's id and scope, exactly as the REST
    // middleware stamps them — not an actor decided as an unscoped key.
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
      action: "runs:read_transcript",
      actor: expect.objectContaining({ source: "agent_key", keyId: "key-1", keyScope: skillTestScope }),
    }));
  });

  it("still streams the transcript to the same agent on a standard key", async () => {
    const sent = await publishCanaries(await connectWithKey({ kind: "standard" }));

    expect(sent).toHaveLength(3);
    for (const frame of sent) expect(frame).toContain(CANARY);
  });
});
