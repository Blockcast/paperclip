import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  isMaskedEchoOfStoredWorkspaceRuntime,
  maskWorkspaceRuntimeForRead,
} from "../redaction.js";

/**
 * PEN-6595 — the `workspaceRuntime` half of the three pipeline stage-config routes.
 *
 * `#3701` (PEN-6532) refused the two COMMAND paths at all three; `#3699` (PEN-6430) refused
 * `executionWorkspaceSettings.workspaceRuntime` at the four ISSUE write routes. Between them
 * these three routes kept writing the same open record with no refusal at all. This suite pins
 * the close, and the close is ASYMMETRIC — which is the whole reason the suite exists rather
 * than one more case in `routine-pipeline-workspace-command-authz.test.ts`.
 *
 *   stage CREATE, pipeline CREATE `stages[]`  -> refuse outright
 *   stage PATCH                               -> admit ONLY the exact value a withheld read of
 *                                                THIS stage would have returned
 *
 * ⛔ THE TWO ARMS MUST BOTH BE ASSERTED OR NEITHER IS WORTH HAVING. A CREATE-only refusal is
 * bypassable one route over by PATCHing the value in afterwards; a PATCH-only refusal leaves
 * the fresh-stage path open. And admitting an echo at a CREATE path would be a HOLE rather
 * than a carve-out — there is no stored value to restore from, so the literal sentinel would
 * persist into a fresh stage config. The CREATE-refuses-an-echo case below is the one that
 * pins that, and it is the case a future "simplify these three to one call" edit would delete.
 *
 * ⛔ AND THE PATCH TEST IS AGAINST THE **STORED** VALUE, NOT THE INCOMING ONE'S OWN MASK. The
 * `STRUCTURE-ONLY` block below is the reason: a fixpoint test admits a body that writes no
 * fresh command string and still changes what the host executes. Those cases were found in
 * review on `#3764`; deleting them re-opens the hole, because every one of them IS a fixpoint.
 *
 * Each denial case asserts BOTH the 403 AND that the service mock was never called. A bare
 * status assertion passes when the request dies at an earlier gate for an unrelated reason,
 * which would make the test green against a guard that was never reached.
 *
 * ⛔ Every value below is invented, and the fixtures deliberately avoid the
 * key/token/secret/password/credential stems `.github/scripts/check-pr-security.mjs` flags on
 * long literals: a security change whose own fixtures report as secrets costs a reviewer a
 * triage every round.
 */

/**
 * A plausible operator-authored runtime config. It carries the three shapes the mask treats
 * differently — a blessed `services` array with identity and enum keys that SURVIVE masking, a
 * free-text leaf that does not, and unrelated prose at the top level — so an echo built from it
 * exercises the carve-out rather than a degenerate all-sentinel object.
 */
const OPERATOR_RUNTIME = {
  services: [
    {
      id: "web",
      name: "web",
      kind: "service",
      lifecycle: "shared",
      command: "pnpm dev",
      cwd: "/srv/app",
      env: { PORT: 3000, MODE: "dev" },
    },
  ],
  notes: "operator prose",
};

/** What a withheld agent reader actually receives. Built with the REAL mask, never by hand. */
const MASKED_ECHO = maskWorkspaceRuntimeForRead(OPERATOR_RUNTIME) as Record<string, unknown>;

/** The stored stage every PATCH case below is tested against. */
const STORED_STAGE_CONFIG = {
  onEnter: { executionWorkspaceSettings: { workspaceRuntime: OPERATOR_RUNTIME } },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const mockPipelineService = vi.hoisted(() => ({
  createPipeline: vi.fn(),
  createStage: vi.fn(),
  updateStage: vi.fn(),
  getPipeline: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

/**
 * A chainable drizzle stand-in. Its single row serves BOTH readers the PATCH route makes:
 * `resolvePipelineCompanyId` reads `companyId`, and the guard's stored-stage read takes
 * `config` — so the stored config is real rather than a fixture the guard never sees.
 */
const mockDb = vi.hoisted(() => {
  const rows = [{
    id: "stage-1",
    pipelineId: "pipeline-1",
    companyId: "company-1",
    config: {
      onEnter: {
        executionWorkspaceSettings: {
          workspaceRuntime: {
            services: [{
              id: "web", name: "web", kind: "service", lifecycle: "shared",
              command: "pnpm dev", cwd: "/srv/app", env: { PORT: 3000, MODE: "dev" },
            }],
            notes: "operator prose",
          },
        },
      },
    },
  }];
  const builder: Record<string, unknown> = {
    then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  for (const method of [
    "select", "from", "where", "limit", "orderBy", "groupBy", "leftJoin", "innerJoin", "offset",
  ]) {
    builder[method] = vi.fn(() => builder);
  }
  return builder;
});

const RUNTIME_PATH_SUFFIX = "executionWorkspaceSettings.workspaceRuntime";

function stageConfig(carrier: "onEnter" | "automation", workspaceRuntime: unknown) {
  return { [carrier]: { executionWorkspaceSettings: { workspaceRuntime } } };
}

function registerCommonMocks() {
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
  vi.doMock("../services/access.js", () => ({ accessService: () => mockAccessService }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    routineService: () => ({}),
  }));
  vi.doMock("../services/pipelines.js", () => ({
    pipelineService: () => mockPipelineService,
    pipelineCaseOutputsService: () => ({}),
  }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: () => null }));
}

async function createPipelineApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { pipelineRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/pipelines.js")>("../routes/pipelines.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", pipelineRoutes(mockDb as any));
  app.use(errorHandler);
  return app;
}

const AGENT_ACTOR = {
  type: "agent",
  agentId: "agent-1",
  runId: "run-1",
  companyIds: ["company-1"],
  companyId: "company-1",
};

const BOARD_ACTOR = {
  type: "board",
  userId: "board-user",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: ["company-1"],
  companyId: "company-1",
};

const STAGE_BODY = { key: "k", name: "n", kind: "working", position: 0 };

describe("PEN-6595 isMaskedEchoOfStoredWorkspaceRuntime", () => {
  const STORED = OPERATOR_RUNTIME;

  it("MUST-PASS: the masked read of the stored value is an echo of it", () => {
    expect(isMaskedEchoOfStoredWorkspaceRuntime(MASKED_ECHO, STORED)).toBe(true);
  });

  it("MUST-REFUSE: a fresh value, and an echo with one leaf changed", () => {
    expect(isMaskedEchoOfStoredWorkspaceRuntime(STORED, STORED)).toBe(false);
    const edited = clone(MASKED_ECHO) as any;
    edited.services[0].command = "sh -c whoami";
    expect(isMaskedEchoOfStoredWorkspaceRuntime(edited, STORED)).toBe(false);
  });

  /**
   * ⛔⛔ THE BLOCK THAT MUST NOT BE DELETED. Every case here is a FIXPOINT of the mask —
   * `maskWorkspaceRuntimeForRead(x)` deep-equals `x` — because the mask passes identity keys
   * and the in-set `kind`/`lifecycle` enums through verbatim. A guard written as a fixpoint
   * test admits all of them, and each changes what the host executes while writing no fresh
   * command string. Found in review on `#3764`; this is why the predicate takes the STORED
   * value. Each case asserts BOTH that it is a fixpoint AND that the guard still refuses it,
   * so a regression to the fixpoint form reds here rather than passing quietly.
   */
  it("STRUCTURE-ONLY ATTACKS: each IS a mask fixpoint and MUST still be refused", () => {
    const duplicated = clone(MASKED_ECHO) as any;
    duplicated.services.push(clone(duplicated.services[0]));

    const kindFlipped = clone(MASKED_ECHO) as any;
    kindFlipped.services[0].kind = "job";

    const lifecycleFlipped = clone(MASKED_ECHO) as any;
    lifecycleFlipped.services[0].lifecycle = "ephemeral";

    const rePointed = clone(MASKED_ECHO) as any;
    rePointed.services[0].id = "worker";
    rePointed.services[0].name = "worker";

    const introduced = clone(MASKED_ECHO) as any;
    introduced.services.push({ id: "extra", command: REDACTED_EVENT_VALUE });

    for (const [label, body] of Object.entries({
      duplicated, kindFlipped, lifecycleFlipped, rePointed, introduced,
    })) {
      // The premise: a fixpoint test would admit every one of these.
      expect([label, maskWorkspaceRuntimeForRead(body)]).toEqual([label, body]);
      // The guard: comparing against the STORED value refuses them.
      expect([label, isMaskedEchoOfStoredWorkspaceRuntime(body, STORED)]).toEqual([label, false]);
    }
  });

  it("MUST-REFUSE: a dropped key, which the restore would turn into a deletion", () => {
    const partial = clone(MASKED_ECHO) as any;
    delete partial.notes;
    expect(isMaskedEchoOfStoredWorkspaceRuntime(partial, STORED)).toBe(false);
  });

  it("MUST-REFUSE: a non-object shape, even when it equals the sentinel", () => {
    // The mask returns the bare sentinel STRING for every non-object shape, so a scalar or
    // array could otherwise match a scalar stored one — the two shape bypasses this series
    // has already shipped once each, read in the write direction.
    expect(isMaskedEchoOfStoredWorkspaceRuntime(REDACTED_EVENT_VALUE, REDACTED_EVENT_VALUE)).toBe(false);
    expect(isMaskedEchoOfStoredWorkspaceRuntime([REDACTED_EVENT_VALUE], [REDACTED_EVENT_VALUE])).toBe(false);
    expect(isMaskedEchoOfStoredWorkspaceRuntime(42, 42)).toBe(false);
    expect(isMaskedEchoOfStoredWorkspaceRuntime(null, STORED)).toBe(false);
  });

  it("a nullish stored value refuses every non-nullish incoming one", () => {
    // Nothing stored means nothing to round-trip, so any value is fresh by definition. This
    // is also what makes the CREATE paths a special case of the same predicate.
    expect(isMaskedEchoOfStoredWorkspaceRuntime(MASKED_ECHO, undefined)).toBe(false);
    expect(isMaskedEchoOfStoredWorkspaceRuntime(MASKED_ECHO, null)).toBe(false);
    expect(isMaskedEchoOfStoredWorkspaceRuntime({}, undefined)).toBe(false);
  });

  it("`{}` is admitted ONLY against a stored `{}`, where it is a true no-op", () => {
    // The fixpoint form needed a hand-written `{}` special case because `{}` masks to itself
    // while the restore — which walks the INCOMING keys — turns it into a wipe. Comparing
    // against the stored value removes that special case instead of keeping it in step.
    expect(isMaskedEchoOfStoredWorkspaceRuntime({}, {})).toBe(true);
    expect(isMaskedEchoOfStoredWorkspaceRuntime({}, STORED)).toBe(false);
  });
});

describe("PEN-6595 pipeline stage-config workspaceRuntime authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/pipelines.js");
    vi.doUnmock("../middleware/index.js");
    registerCommonMocks();
    vi.clearAllMocks();
    mockPipelineService.createPipeline.mockResolvedValue({ id: "pipeline-1", stages: [] });
    mockPipelineService.createStage.mockResolvedValue({ id: "stage-1", config: {} });
    mockPipelineService.updateStage.mockResolvedValue({ id: "stage-1", config: {} });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_test", explanation: "ok" });
  });

  it("FIXTURE CONTROL: the mock's stored stage is the config these PATCH cases assume", () => {
    // Without this the whole PATCH arm could be green because the stored value is absent and
    // everything refuses — which looks identical to a working guard on the denial cases.
    expect(STORED_STAGE_CONFIG.onEnter.executionWorkspaceSettings.workspaceRuntime)
      .toEqual(OPERATOR_RUNTIME);
  });

  for (const carrier of ["onEnter", "automation"] as const) {
    it(`refuses an agent that sets config.${carrier} workspaceRuntime on stage create`, async () => {
      const app = await createPipelineApp(AGENT_ACTOR);
      const res = await request(app)
        .post("/api/pipelines/pipeline-1/stages")
        .send({ ...STAGE_BODY, config: stageConfig(carrier, OPERATOR_RUNTIME) });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain(`config.${carrier}.${RUNTIME_PATH_SUFFIX}`);
      expect(mockPipelineService.createStage).not.toHaveBeenCalled();
    });

    it(`refuses an agent that sets config.${carrier} workspaceRuntime on stage patch`, async () => {
      const app = await createPipelineApp(AGENT_ACTOR);
      const res = await request(app)
        .patch("/api/pipelines/pipeline-1/stages/stage-1")
        .send({ config: stageConfig(carrier, OPERATOR_RUNTIME) });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain(`config.${carrier}.${RUNTIME_PATH_SUFFIX}`);
      expect(mockPipelineService.updateStage).not.toHaveBeenCalled();
    });

    it(`MUST-PASS: stage patch admits an unmodified echo on config.${carrier}`, async () => {
      // BOTH carriers compare against the stored `onEnter` block, matching the restore, which
      // keys `automation` off stored `onEnter` because no stored row can carry an `automation`.
      const app = await createPipelineApp(AGENT_ACTOR);
      const res = await request(app)
        .patch("/api/pipelines/pipeline-1/stages/stage-1")
        .send({ name: "renamed", config: stageConfig(carrier, MASKED_ECHO) });
      expect(res.status).toBe(200);
      expect(mockPipelineService.updateStage).toHaveBeenCalledTimes(1);
    });
  }

  it("ROUTE-LEVEL STRUCTURE-ONLY ATTACK: a duplicated service echo is refused at stage patch", async () => {
    // End-to-end counterpart of the unit block above: this body is a mask fixpoint, writes no
    // fresh command string, and would make the runtime start the operator's command twice.
    const duplicated = clone(MASKED_ECHO) as any;
    duplicated.services.push(clone(duplicated.services[0]));
    const app = await createPipelineApp(AGENT_ACTOR);
    const res = await request(app)
      .patch("/api/pipelines/pipeline-1/stages/stage-1")
      .send({ config: stageConfig("onEnter", duplicated) });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain(`config.onEnter.${RUNTIME_PATH_SUFFIX}`);
    expect(mockPipelineService.updateStage).not.toHaveBeenCalled();
  });

  it("refuses an agent that smuggles a workspaceRuntime through pipeline CREATE's stages[]", async () => {
    const app = await createPipelineApp(AGENT_ACTOR);
    const res = await request(app)
      .post("/api/companies/company-1/pipelines")
      .send({
        key: "p",
        name: "P",
        stages: [
          { key: "a", name: "A", kind: "working" },
          { key: "b", name: "B", kind: "working", config: stageConfig("automation", OPERATOR_RUNTIME) },
        ],
      });
    expect(res.status).toBe(403);
    // The index is load-bearing: one body carries many stages and the clean ones must not be
    // implicated.
    expect(res.body.error).toContain(`stages[1].config.automation.${RUNTIME_PATH_SUFFIX}`);
    expect(mockPipelineService.createPipeline).not.toHaveBeenCalled();
  });

  it("THE ASYMMETRY: the SAME echo PATCH admits is refused at stage create and pipeline create", async () => {
    // Nothing restores at a CREATE path, so admitting this would persist the literal sentinel
    // into a fresh stage config. Deleting this case is how a "simplify to one call" edit turns
    // the carve-out into a hole.
    const app = await createPipelineApp(AGENT_ACTOR);
    const stage = await request(app)
      .post("/api/pipelines/pipeline-1/stages")
      .send({ ...STAGE_BODY, config: stageConfig("onEnter", MASKED_ECHO) });
    expect(stage.status).toBe(403);
    expect(stage.body.error).toContain(`config.onEnter.${RUNTIME_PATH_SUFFIX}`);
    expect(mockPipelineService.createStage).not.toHaveBeenCalled();

    const pipeline = await request(app)
      .post("/api/companies/company-1/pipelines")
      .send({
        key: "p",
        name: "P",
        stages: [{ key: "a", name: "A", kind: "working", config: stageConfig("onEnter", MASKED_ECHO) }],
      });
    expect(pipeline.status).toBe(403);
    expect(pipeline.body.error).toContain(`stages[0].config.onEnter.${RUNTIME_PATH_SUFFIX}`);
    expect(mockPipelineService.createPipeline).not.toHaveBeenCalled();
  });

  it("refuses an empty record at stage PATCH against a non-empty stored config", async () => {
    const app = await createPipelineApp(AGENT_ACTOR);
    const res = await request(app)
      .patch("/api/pipelines/pipeline-1/stages/stage-1")
      .send({ config: stageConfig("onEnter", {}) });
    expect(res.status).toBe(403);
    expect(mockPipelineService.updateStage).not.toHaveBeenCalled();
  });

  it("refuses a non-object workspaceRuntime at stage PATCH even when it IS the sentinel", async () => {
    const app = await createPipelineApp(AGENT_ACTOR);
    for (const shape of [REDACTED_EVENT_VALUE, [REDACTED_EVENT_VALUE]] as unknown[]) {
      const res = await request(app)
        .patch("/api/pipelines/pipeline-1/stages/stage-1")
        .send({ config: stageConfig("onEnter", shape) });
      expect(res.status).toBe(403);
    }
    expect(mockPipelineService.updateStage).not.toHaveBeenCalled();
  });

  it("MUST-PASS: a nullish workspaceRuntime, and a stage config carrying none, still write", async () => {
    const app = await createPipelineApp(AGENT_ACTOR);
    const explicitNull = await request(app)
      .post("/api/pipelines/pipeline-1/stages")
      .send({ ...STAGE_BODY, config: stageConfig("onEnter", null) });
    expect(explicitNull.status).toBe(201);

    const absent = await request(app)
      .post("/api/pipelines/pipeline-1/stages")
      .send({ ...STAGE_BODY, config: { onEnter: { executionWorkspaceSettings: { mode: "shared_workspace" } } } });
    expect(absent.status).toBe(201);
    expect(mockPipelineService.createStage).toHaveBeenCalledTimes(2);
  });

  it("MUST-PASS: a stage PATCH carrying no workspaceRuntime at all still writes", async () => {
    // The stored-row read is gated on the field being present, so this is also the case that
    // proves an ordinary PATCH does not pay for the extra query.
    const app = await createPipelineApp(AGENT_ACTOR);
    const res = await request(app)
      .patch("/api/pipelines/pipeline-1/stages/stage-1")
      .send({ name: "renamed" });
    expect(res.status).toBe(200);
    expect(mockPipelineService.updateStage).toHaveBeenCalledTimes(1);
  });

  it("the two refusal remedies differ, and the PATCH one must NOT offer `null`", async () => {
    // At stage PATCH a `null` DELETES the operator's stored runtime config rather than clearing
    // a redaction marker, so the issue-route refusal's own "send `null`" text would be a
    // destructive instruction here. Pinned because one shared message string is the obvious
    // tidy-up and it is wrong.
    const app = await createPipelineApp(AGENT_ACTOR);
    const create = await request(app)
      .post("/api/pipelines/pipeline-1/stages")
      .send({ ...STAGE_BODY, config: stageConfig("onEnter", OPERATOR_RUNTIME) });
    const patch = await request(app)
      .patch("/api/pipelines/pipeline-1/stages/stage-1")
      .send({ config: stageConfig("onEnter", OPERATOR_RUNTIME) });
    expect(create.body.error).toContain("send `null`");
    expect(patch.body.error).toContain("Do NOT send `null` here");
    expect(patch.body.error).not.toContain("Omit the key, or send `null`");
  });

  it("NON-AGENT CONTROL: a board actor may still set a stage workspaceRuntime", async () => {
    const app = await createPipelineApp(BOARD_ACTOR);
    const created = await request(app)
      .post("/api/pipelines/pipeline-1/stages")
      .send({ ...STAGE_BODY, config: stageConfig("onEnter", OPERATOR_RUNTIME) });
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch("/api/pipelines/pipeline-1/stages/stage-1")
      .send({ config: stageConfig("automation", OPERATOR_RUNTIME) });
    expect(patched.status).toBe(200);
    expect(mockPipelineService.createStage).toHaveBeenCalledTimes(1);
    expect(mockPipelineService.updateStage).toHaveBeenCalledTimes(1);
  });

  it("MUST-PASS: the command refusal still fires, and reports the MORE SPECIFIC path", async () => {
    // Order is load-bearing for the message: a body tripping both guards names the path that
    // actually reaches a shell, not the whole-field one.
    const app = await createPipelineApp(AGENT_ACTOR);
    const res = await request(app)
      .post("/api/pipelines/pipeline-1/stages")
      .send({
        ...STAGE_BODY,
        config: {
          onEnter: {
            executionWorkspaceSettings: {
              workspaceStrategy: { provisionCommand: "sh -c id" },
              workspaceRuntime: OPERATOR_RUNTIME,
            },
          },
        },
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("workspaceStrategy.provisionCommand");
    expect(mockPipelineService.createStage).not.toHaveBeenCalled();
  });
});
