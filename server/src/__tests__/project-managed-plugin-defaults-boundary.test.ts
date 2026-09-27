import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { publicProject } from "../routes/workspace-response.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

/**
 * PEN-3144 (door #18 of the PEN-2370 series) — plugin-authored `managedByPlugin.defaultsJson` on the
 * PROJECT routes.
 *
 * ## Why this file exists when the mask is already tested
 *
 * The walk lives once, in `publicProjectManagedByPlugin` (`routes/workspace-response.ts`), and
 * PEN-3210 / #2012 pins it two ways: structurally in `workspace-response-withholding-guard.test.ts`,
 * and behaviourally at ONE exit — `mentionedProjects[]` on `GET /issues/:id`. That is the issue
 * endpoint.
 *
 * This row is the PROJECT endpoints, and they are the wider surface: a project read needs no issue.
 * `GET /projects/:id`, `GET /companies/:companyId/projects`, `POST /companies/:companyId/projects`
 * and `PATCH /projects/:id` all reach the field through `publicProject`, so they INHERIT that mask —
 * and "inherits" is a claim about a call graph, which is the kind of claim that stops being true
 * without anybody editing the function it was made about. One of these four exits growing a local
 * projection, or being re-pointed at the raw row, would leave every existing test green. So each
 * exit is asserted at the exit, by value, rather than argued from the shared site.
 *
 * ⛔ Not probed. Reading a live plugin-managed project IS this row's exposure; the finding was
 * confirmed from source only, per the standing PEN-2370 prohibition. Every fixture value below is
 * invented and no real credential appears anywhere in this file.
 *
 * ## Why the secret constant is unique to this file
 *
 * `not.toContain` over the serialized body is only meaningful if THIS test's secret can only be
 * masked by the control THIS test is about. Sharing a sibling door's constant would let an
 * already-merged mask elsewhere in the same response satisfy the assertion, and the test would pass
 * against unfixed code (the PEN-3130 lesson). Hence a value distinct from PEN-3114's
 * `invented-plugin-defaults-fixture-value` and PEN-3210's `invented-mentioned-project-defaults-fixture`.
 */

const PLUGIN_DEFAULTS_SECRET = "invented-project-route-plugin-defaults-fixture";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetTelemetryClient = vi.hoisted(() => vi.fn(() => null));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(async () => undefined),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
  trackProjectCreated: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  projectService: () => mockProjectService,
  documentAnnotationService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn() }),
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({
    listForExecutionWorkspace: vi.fn(),
    createRecorder: vi.fn(),
  }),
}));

vi.mock("../services/secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/secrets.js")>()),
  secretService: () => mockSecretService,
}));

/**
 * A plugin binding as the hydrator produces one (`services/projects.ts`). `defaultsJson` is an open
 * `Record` over a `jsonb` column whose `settings` leaf is copied verbatim out of a third-party
 * manifest — that leaf is the credential-shaped one and the reason this door exists.
 */
function managedByPluginFixture() {
  return {
    id: "plugin-binding-1",
    pluginId: "plugin-1",
    pluginKey: "acme-deploy",
    pluginDisplayName: "Acme Deploy",
    resourceKind: "project",
    resourceKey: "deploy",
    defaultsJson: {
      projectKey: "deploy",
      displayName: "Deploy",
      color: null,
      settings: {
        DEPLOY_WEBHOOK_SECRET: PLUGIN_DEFAULTS_SECRET,
        region: "us-east-1",
      },
    },
    createdAt: new Date("2026-03-20T00:00:00Z"),
    updatedAt: new Date("2026-03-20T00:00:00Z"),
  };
}

function projectFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    name: "Alpha",
    env: null,
    executionWorkspacePolicy: null,
    managedByPlugin: managedByPluginFixture(),
    workspaces: [],
    primaryWorkspace: null,
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      companyIds: ["company-1"],
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/**
 * The emitted binding must stay ADDRESSABLE and stay SHAPED, and must not carry the value. Asserting
 * only the first two would stay green against a verbatim passthrough, which keeps the key set
 * byte-identical; asserting only the third would let a fix that blanks the binding to `{}` pass,
 * which breaks the UI readers (`pluginKey`, `pluginDisplayName`) and erases the key names ask 1
 * requires be kept. All three together are what pins the intended behaviour.
 */
function expectMaskedBinding(emitted: any) {
  expect(emitted.pluginKey).toBe("acme-deploy");
  expect(emitted.pluginDisplayName).toBe("Acme Deploy");
  expect(emitted.resourceKey).toBe("deploy");

  expect(Object.keys(emitted.defaultsJson)).toEqual([
    "projectKey",
    "displayName",
    "color",
    "settings",
  ]);
  expect(Object.keys(emitted.defaultsJson.settings)).toEqual([
    "DEPLOY_WEBHOOK_SECRET",
    "region",
  ]);

  expect(emitted.defaultsJson.settings.DEPLOY_WEBHOOK_SECRET).toBe(REDACTED_EVENT_VALUE);
  expect(emitted.defaultsJson.settings.region).toBe(REDACTED_EVENT_VALUE);
  expect(emitted.defaultsJson.displayName).toBe(REDACTED_EVENT_VALUE);
  // `null` carries nothing and stays `null` rather than becoming the sentinel.
  expect(emitted.defaultsJson.color).toBeNull();
}

describe("project plugin-defaults disclosure boundary (PEN-3144)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue(null);
    mockProjectService.getById.mockResolvedValue(projectFixture());
    mockProjectService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      project: projectFixture(),
    });
    mockProjectService.list.mockResolvedValue([projectFixture()]);
    mockProjectService.create.mockResolvedValue(projectFixture());
    mockProjectService.update.mockResolvedValue(projectFixture());
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(
      async (_companyId: string, env: unknown) => env,
    );
  });

  /**
   * ⚠️ The `granted` case is the load-bearing one and it is not redundant with the `denied` case.
   * `publicProject` early-returns the whole row for an entitled viewer:
   *
   *     const masked = maskProjectManagedByPluginDefaults(maskProjectEnv(project));
   *     if (viewer.revealRuntimeConfig) return masked;   // ← everything below is skipped
   *
   * so a mask written into the object literal BELOW that line — the obvious place, next to
   * `workspaces` and `primaryWorkspace` — masks nothing for the caller most likely to be an entitled
   * human operator, while passing an unentitled-only test. `defaultsJson` is plugin-manifest
   * material and `workspace_runtime:read` is scoped to workspace runtime config, so no viewer is
   * entitled to it and the mask must sit ABOVE that return. Every exit below is therefore
   * parameterised: the guard on the shared site pins the ordering once, and these pin that each exit
   * is actually behind it.
   */
  for (const revealRuntimeConfig of [true, false]) {
    const entitlement = `workspace_runtime:read ${revealRuntimeConfig ? "granted" : "denied"}`;

    describe(`route exits (${entitlement})`, () => {
      beforeEach(() => {
        mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
          allowed: revealRuntimeConfig || input.action !== "workspace_runtime:read",
          action: input.action,
          reason: "allow_test",
          explanation: "Allowed by test mock.",
        }));
      });

      it("masks plugin-authored defaultsJson on GET /projects/:id", async () => {
        const res = await request(createApp()).get("/api/projects/project-1");

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(PLUGIN_DEFAULTS_SECRET);
        expectMaskedBinding(res.body.managedByPlugin);
      });

      it("masks plugin-authored defaultsJson on GET /companies/:companyId/projects — the widest exit", async () => {
        // The bulk exit: one call returns every project in the company, so a leak here is the whole
        // estate rather than one row. It reaches the field through `publicProjects`, a DIFFERENT
        // entry point that maps over `publicProject` — which is why it is asserted separately rather
        // than assumed to travel with the single-project read above.
        const res = await request(createApp()).get("/api/companies/company-1/projects");

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(PLUGIN_DEFAULTS_SECRET);
        expect(Array.isArray(res.body)).toBe(true);
        expectMaskedBinding(res.body[0].managedByPlugin);
      });

      it("masks plugin-authored defaultsJson on PATCH /projects/:id", async () => {
        const res = await request(createApp())
          .patch("/api/projects/project-1")
          .send({ name: "Renamed" });

        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain(PLUGIN_DEFAULTS_SECRET);
        expectMaskedBinding(res.body.managedByPlugin);
      });

      it("masks plugin-authored defaultsJson on POST /companies/:companyId/projects", async () => {
        const res = await request(createApp())
          .post("/api/companies/company-1/projects")
          .send({ name: "Alpha" });

        expect(res.status).toBe(201);
        expect(JSON.stringify(res.body)).not.toContain(PLUGIN_DEFAULTS_SECRET);
        expectMaskedBinding(res.body.managedByPlugin);
      });
    });
  }

  /**
   * `DELETE /projects/:id` answers with the bare row from `svc.remove` and deliberately skips
   * `publicProject` (`routes/projects.ts` — the deleted row has no `workspaces[]` to satisfy the
   * helper's constraint). `managedByPlugin` is HYDRATED rather than selected, so that row has no such
   * key at all and there is nothing to mask there.
   *
   * Asserting the key's absence on that route would only re-describe this file's own `remove` mock.
   * What is worth pinning is the contract that makes the exemption safe — that the projection does
   * not INVENT the key on a row that never carried one — which is a property of `publicProject`
   * itself and is asserted directly against it. Without this, the natural "just always set
   * `managedByPlugin`" simplification of the runtime key check would add a field to a response that
   * has never carried one, silently, with every route test still green.
   */
  it("does not invent managedByPlugin on a row that never carried the key", () => {
    // `workspaces`/`primaryWorkspace` are present because the unentitled branch maps over them
    // unconditionally — the very constraint `DELETE /projects/:id` cites for skipping this
    // projection, so the truly bare deleted row could not traverse this function at all. What is
    // varied here is only the presence of the `managedByPlugin` KEY.
    const unhydrated = {
      id: "project-1",
      companyId: "company-1",
      name: "Alpha",
      workspaces: [],
      primaryWorkspace: null,
    };

    for (const revealRuntimeConfig of [true, false]) {
      const projected = publicProject(structuredClone(unhydrated) as any, { revealRuntimeConfig });
      expect("managedByPlugin" in projected).toBe(false);
    }
  });

  /**
   * A hydrated row whose project simply has no plugin binding comes back with the key already
   * present and `null`. Normalising that through the projection must stay a no-op — a reader
   * branching on `managedByPlugin === null` is the documented UI idiom (`ProjectDetail.tsx` reads the
   * binding's mere existence).
   */
  it("leaves a hydrated row with no plugin binding as null", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    }));
    mockProjectService.getById.mockResolvedValue(projectFixture({ managedByPlugin: null }));

    const res = await request(createApp()).get("/api/projects/project-1");

    expect(res.status).toBe(200);
    expect(res.body.managedByPlugin).toBeNull();
  });
});
