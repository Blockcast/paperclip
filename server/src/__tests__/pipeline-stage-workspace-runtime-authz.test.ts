import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  isMaskedWorkspaceRuntimeEcho,
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
 *   stage PATCH                               -> refuse a FRESH value, admit an unmodified
 *                                                echo of a masked read
 *
 * ⛔ THE TWO ARMS MUST BOTH BE ASSERTED OR NEITHER IS WORTH HAVING. A CREATE-only refusal is
 * bypassable one route over by PATCHing the value in afterwards; a PATCH-only refusal leaves
 * the fresh-stage path open. And admitting an echo at a CREATE path would be a HOLE rather
 * than a carve-out — there is no stored value to restore from, so the literal sentinel would
 * persist into a fresh stage config. The CREATE-refuses-an-echo case below is the one that
 * pins that, and it is the case a future "simplify these three to one call" edit would delete.
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

const mockDb = vi.hoisted(() => {
  const rows = [{ id: "pipeline-1", companyId: "company-1" }];
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
const MASKED_ECHO = maskWorkspaceRuntimeForRead(OPERATOR_RUNTIME);

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

describe("PEN-6595 isMaskedWorkspaceRuntimeEcho", () => {
  it("MUST-PASS: the mask is idempotent, so its own output is an echo", () => {
    expect(maskWorkspaceRuntimeForRead(MASKED_ECHO)).toEqual(MASKED_ECHO);
    expect(isMaskedWorkspaceRuntimeEcho(MASKED_ECHO)).toBe(true);
  });

  it("MUST-REFUSE: a fresh value, and a masked echo with one leaf changed", () => {
    expect(isMaskedWorkspaceRuntimeEcho(OPERATOR_RUNTIME)).toBe(false);
    const edited = JSON.parse(JSON.stringify(MASKED_ECHO));
    edited.services[0].command = "sh -c whoami";
    expect(isMaskedWorkspaceRuntimeEcho(edited)).toBe(false);
  });

  it("MUST-REFUSE: an added key, an added array element, and a fresh non-string leaf", () => {
    const addedKey = JSON.parse(JSON.stringify(MASKED_ECHO));
    addedKey.services[0].extra = "added";
    expect(isMaskedWorkspaceRuntimeEcho(addedKey)).toBe(false);

    const addedElement = JSON.parse(JSON.stringify(MASKED_ECHO));
    addedElement.services.push({ id: "second", command: "sh -c id" });
    expect(isMaskedWorkspaceRuntimeEcho(addedElement)).toBe(false);

    const freshNumber = JSON.parse(JSON.stringify(MASKED_ECHO));
    freshNumber.services[0].env.PORT = 9999;
    expect(isMaskedWorkspaceRuntimeEcho(freshNumber)).toBe(false);
  });

  it("MUST-REFUSE: a non-object shape, even when it equals the sentinel", () => {
    // The mask returns the bare sentinel STRING for every non-object shape, so a scalar or
    // array would otherwise be its own fixpoint — the two shape bypasses this series has
    // already shipped once each, read in the write direction.
    expect(isMaskedWorkspaceRuntimeEcho(REDACTED_EVENT_VALUE)).toBe(false);
    expect(isMaskedWorkspaceRuntimeEcho([REDACTED_EVENT_VALUE])).toBe(false);
    expect(isMaskedWorkspaceRuntimeEcho(42)).toBe(false);
    expect(isMaskedWorkspaceRuntimeEcho(null)).toBe(false);
  });

  it("honours an identity key only where the mask does, and refuses a forged enum", () => {
    // `id`/`name` survive on an entry sitting directly inside a blessed top-level array…
    expect(isMaskedWorkspaceRuntimeEcho({ services: [{ id: "web", command: REDACTED_EVENT_VALUE }] })).toBe(true);
    // …and nowhere else, so the same spelling one level over is not an echo.
    expect(isMaskedWorkspaceRuntimeEcho({ extras: { name: "web" } })).toBe(false);
    // An out-of-set enum value can never have come out of the mask.
    expect(isMaskedWorkspaceRuntimeEcho({ services: [{ kind: "not-an-enum" }] })).toBe(false);
  });

  it("RECORDED RESIDUAL: `{}` is a fixpoint here, which is why the ROUTE refuses it", () => {
    // Pinned so the division of labour is a visible choice: this predicate answers "could a
    // masked read have produced this", the route answers "is admitting it non-destructive".
    expect(isMaskedWorkspaceRuntimeEcho({})).toBe(true);
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
  }

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

  it("MUST-PASS: stage PATCH admits an unmodified echo of a masked read", async () => {
    const app = await createPipelineApp(AGENT_ACTOR);
    const res = await request(app)
      .patch("/api/pipelines/pipeline-1/stages/stage-1")
      .send({ name: "renamed", config: stageConfig("onEnter", MASKED_ECHO) });
    expect(res.status).toBe(200);
    expect(mockPipelineService.updateStage).toHaveBeenCalledTimes(1);
  });

  it("THE ASYMMETRY: the SAME echo is refused at stage create and at pipeline create", async () => {
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

  it("refuses an empty record at stage PATCH: `{}` is a mask fixpoint and REPLACES the stored config", async () => {
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
