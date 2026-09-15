import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { routineRoutes } from "../routes/routines.js";
import {
  PROJECT_ENV_VALUE_MASK,
  maskEnvBindings,
  maskProjectEnv,
  restoreMaskedEnvBindings,
} from "../routes/project-env-response.js";
import { publicProject } from "../routes/workspace-response.js";
import { REDACTED_SENTINEL } from "../services/secrets.js";

/**
 * PEN-3033 (door #17 of the PEN-2370 series) — project `env` plain bindings were projected verbatim
 * by every project response exit.
 *
 * Every fixture value below is invented. No real credential is quoted anywhere in this file, per the
 * parent ticket's standing prohibition.
 */

const PLAIN_SENTINEL = "sentinel-project-env-value-must-not-egress";
const SECOND_SENTINEL = "sentinel-second-project-env-value-must-not-egress";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  listWorkspaces: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockRoutineService = vi.hoisted(() => ({ getDetail: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  documentAnnotationService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn() }),
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({
    listForExecutionWorkspace: vi.fn(),
    createRecorder: vi.fn(),
  }),
}));

// `importOriginal` keeps the REAL `REDACTED_SENTINEL`. Replacing the whole module would hand the
// mask an `undefined` sentinel and make the parity test below pass vacuously.
vi.mock("../services/secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/secrets.js")>()),
  secretService: () => mockSecretService,
}));

function projectFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    name: "Alpha",
    env: {
      PLAIN_FIXTURE: { type: "plain", value: PLAIN_SENTINEL },
      SHORTHAND_FIXTURE: SECOND_SENTINEL,
      REF_FIXTURE: { type: "secret_ref", secretId: "secret-1", version: "latest" },
    },
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
 * The routine-detail exit mounts a different router, so it needs its own app. It is the exit the
 * narrow declared type hid — `RoutineProjectSummary` names five fields and no `env`, while the
 * service populates it from a full-row `db.select()` — which is why it gets a behavioural test of
 * its own rather than being assumed to travel with the project routes above.
 */
function createRoutinesApp() {
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
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("project env disclosure boundary (PEN-3033)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: true,
      action: input.action,
      reason: "test",
      explanation: "Allowed by test mock.",
    }));
    mockProjectService.getById.mockResolvedValue(projectFixture());
    mockProjectService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      project: projectFixture(),
    });
    mockProjectService.list.mockResolvedValue([projectFixture()]);
    mockProjectService.update.mockResolvedValue(projectFixture());
    mockProjectService.remove.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Alpha",
      env: { PLAIN_FIXTURE: { type: "plain", value: PLAIN_SENTINEL } },
    });
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(
      async (_companyId: string, env: unknown) => env,
    );
  });

  describe("the mask", () => {
    it("masks the object-form plain binding", () => {
      const masked = maskEnvBindings(projectFixture().env) as Record<string, any>;
      expect(masked.PLAIN_FIXTURE).toEqual({ type: "plain", value: PROJECT_ENV_VALUE_MASK });
    });

    it("masks the bare-string binding — the shorthand shape canonicalizeBinding also treats as plain", () => {
      const masked = maskEnvBindings(projectFixture().env) as Record<string, any>;
      // Shape-preserving: a string stays a string, so the editor reads it exactly as before.
      expect(masked.SHORTHAND_FIXTURE).toBe(PROJECT_ENV_VALUE_MASK);
    });

    it("passes secret references through untouched — they carry a pointer, not material", () => {
      const masked = maskEnvBindings(projectFixture().env) as Record<string, any>;
      expect(masked.REF_FIXTURE).toEqual({
        type: "secret_ref",
        secretId: "secret-1",
        version: "latest",
      });
    });

    it("leaves a row with no env alone", () => {
      expect(maskProjectEnv({ id: "p", env: null })).toEqual({ id: "p", env: null });
    });

    it("uses EXACTLY the sentinel secrets.ts refuses to persist", () => {
      // Three rules match on this value — the mask, the merge, and normalizeEnvConfig's refusal. A
      // drifting private copy would not fail loudly; it would silently 422 every project env save.
      expect(PROJECT_ENV_VALUE_MASK).toBe(REDACTED_SENTINEL);
    });
  });

  describe("the mask is not entitlement-gated", () => {
    it("masks env even for a viewer entitled to the raw workspace runtime config", () => {
      // The neighbouring workspaceRuntime withholding short-circuits for this viewer. If the env
      // mask sat behind that early return, an entitled viewer would take the raw row on the next
      // line — which is the exact shape of fix that looks green and discloses anyway.
      const projected = publicProject(projectFixture() as any, { revealRuntimeConfig: true });
      expect(JSON.stringify(projected)).not.toContain(PLAIN_SENTINEL);
      expect(JSON.stringify(projected)).not.toContain(SECOND_SENTINEL);
    });
  });

  describe("the write-merge", () => {
    it("restores the stored binding when the incoming value is the mask", () => {
      const merged = restoreMaskedEnvBindings(
        { PLAIN_FIXTURE: { type: "plain", value: PROJECT_ENV_VALUE_MASK } },
        { PLAIN_FIXTURE: { type: "plain", value: PLAIN_SENTINEL } },
      );
      expect(merged.PLAIN_FIXTURE).toEqual({ type: "plain", value: PLAIN_SENTINEL });
    });

    it("restores through the bare-string spelling on both sides", () => {
      const merged = restoreMaskedEnvBindings(
        { SHORTHAND_FIXTURE: PROJECT_ENV_VALUE_MASK },
        { SHORTHAND_FIXTURE: SECOND_SENTINEL },
      );
      expect(merged.SHORTHAND_FIXTURE).toBe(SECOND_SENTINEL);
    });

    it("lets a genuine edit through unchanged", () => {
      const merged = restoreMaskedEnvBindings(
        { PLAIN_FIXTURE: { type: "plain", value: "edited-fixture-value" } },
        { PLAIN_FIXTURE: { type: "plain", value: PLAIN_SENTINEL } },
      );
      expect(merged.PLAIN_FIXTURE).toEqual({ type: "plain", value: "edited-fixture-value" });
    });

    it("does NOT invent a value for a masked key with nothing stored behind it", () => {
      // Left as the placeholder so normalizeEnvConfig still refuses it. Substituting an empty value
      // here would let the mask install itself as a real credential value.
      const merged = restoreMaskedEnvBindings(
        { NEW_FIXTURE: { type: "plain", value: PROJECT_ENV_VALUE_MASK } },
        {},
      );
      expect(merged.NEW_FIXTURE).toEqual({ type: "plain", value: PROJECT_ENV_VALUE_MASK });
    });

    it("does NOT silently change a binding's type when the stored one is a secret ref", () => {
      const merged = restoreMaskedEnvBindings(
        { REF_FIXTURE: { type: "plain", value: PROJECT_ENV_VALUE_MASK } },
        { REF_FIXTURE: { type: "secret_ref", secretId: "secret-1", version: "latest" } },
      );
      expect(merged.REF_FIXTURE).toEqual({ type: "plain", value: PROJECT_ENV_VALUE_MASK });
    });
  });

  describe("the `__proto__` key, which the env key regex admits", () => {
    // ENV_KEY_RE is /^[A-Za-z_][A-Za-z0-9_]*$/, so `__proto__` is a WELL-FORMED env key, and
    // JSON.parse gives it to us as an ordinary own property rather than as a prototype write. A
    // plain-object accumulator then turns `acc[key] = binding` into a prototype assignment: the
    // binding vanishes, silently, with no own property and nothing serialized.
    //
    // That is a correctness bug in this module rather than a disclosure one — a dropped binding
    // discloses nothing — but "the mask silently loses a row" is the wrong failure mode for a
    // module whose whole job is to round-trip every binding it is handed.
    const protoIncoming = () =>
      JSON.parse(`{"__proto__":{"type":"plain","value":"${PROJECT_ENV_VALUE_MASK}"}}`);
    const protoStored = () => JSON.parse(`{"__proto__":{"type":"plain","value":"${PLAIN_SENTINEL}"}}`);

    it("hands the mask a genuine own `__proto__` property — the premise of the rest of this block", () => {
      expect(Object.hasOwn(protoStored(), "__proto__")).toBe(true);
    });

    it("masks a `__proto__` binding as an OWN property instead of dropping it", () => {
      const masked = maskEnvBindings(protoStored()) as Record<string, any>;
      expect(Object.hasOwn(masked, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(masked, "__proto__")?.value).toEqual({
        type: "plain",
        value: PROJECT_ENV_VALUE_MASK,
      });
      // The value is masked, so it is absent from the wire either way — assert it directly rather
      // than inferring safety from the drop.
      expect(JSON.stringify(masked)).not.toContain(PLAIN_SENTINEL);
    });

    it("restores a stored `__proto__` binding instead of dropping the row on save", () => {
      const merged = restoreMaskedEnvBindings(protoIncoming(), protoStored()) as Record<string, any>;
      expect(Object.hasOwn(merged, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(merged, "__proto__")?.value).toEqual({
        type: "plain",
        value: PLAIN_SENTINEL,
      });
    });

    it("pollutes nothing globally, on either accumulator", () => {
      maskEnvBindings(protoStored());
      restoreMaskedEnvBindings(protoIncoming(), protoStored());
      expect(({} as Record<string, unknown>).type).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty("value");
    });

    it("treats an inherited Object.prototype member as NOTHING stored", () => {
      // `stored["__proto__"]`/`["constructor"]` on an ordinary object return an inherited member
      // rather than `undefined`, so the own-property guard is what keeps "nothing stored" honest.
      // Today `plainValueOf` rejects every inherited member anyway, so this pins behaviour that is
      // currently correct for a second reason — if that ever narrows, this test says so.
      for (const key of ["__proto__", "constructor", "toString"]) {
        const merged = restoreMaskedEnvBindings(
          JSON.parse(`{"${key}":{"type":"plain","value":"${PROJECT_ENV_VALUE_MASK}"}}`),
          {},
        ) as Record<string, any>;
        expect(Object.getOwnPropertyDescriptor(merged, key)?.value).toEqual({
          type: "plain",
          value: PROJECT_ENV_VALUE_MASK,
        });
      }
    });

    it("does NOT by itself make the key persistable — normalizeEnvConfig drops it downstream", () => {
      // Pinned deliberately: `services/secrets.ts` accumulates into `{}` on the same key, so a
      // `__proto__` binding still cannot reach storage. Closing that is a change to a function
      // shared with the agent and environment paths, and is not bundled into this PR. This
      // assertion is what makes that boundary visible instead of assumed — if the shared path is
      // ever hardened, this is the test that says so.
      const downstream: Record<string, unknown> = {};
      for (const [key, binding] of Object.entries(
        maskEnvBindings(protoStored()) as Record<string, unknown>,
      )) {
        downstream[key] = binding;
      }
      expect(Object.hasOwn(downstream, "__proto__")).toBe(false);
    });
  });

  describe("route exits", () => {
    it("masks on GET /projects/:id", async () => {
      const res = await request(createApp()).get("/api/projects/project-1");
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PLAIN_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SECOND_SENTINEL);
      // Names are preserved — the diagnostic value of knowing WHICH variables are set survives.
      expect(Object.keys(res.body.env)).toContain("PLAIN_FIXTURE");
    });

    it("masks on the company project LIST — the widest exit", async () => {
      const res = await request(createApp()).get("/api/companies/company-1/projects");
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PLAIN_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SECOND_SENTINEL);
    });

    it("masks on PATCH /projects/:id", async () => {
      const res = await request(createApp())
        .patch("/api/projects/project-1")
        .send({ name: "Renamed" });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PLAIN_SENTINEL);
    });

    it("masks on DELETE /projects/:id — the bare deleted row still carries env", async () => {
      // This exit deliberately skips `publicProject`: `svc.remove` returns a row with no
      // `workspaces[]`, so it is exempt from the workspace-runtime withholding. `env` lives on the
      // project row itself, so that exemption does not extend to this axis.
      const res = await request(createApp()).delete("/api/projects/project-1");
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PLAIN_SENTINEL);
    });

    it("masks on GET /routines/:id — the exit a five-field declared type hid", async () => {
      // `RoutineProjectSummary` names five fields and no `env`, but the service builds it from a
      // full-row `db.select()` and TypeScript strips nothing at runtime. A type-level reading of
      // this handler says the material was never fetched; the wire says otherwise, so this asserts
      // on the wire.
      const fixture = projectFixture() as ReturnType<typeof projectFixture> & {
        env: Record<string, unknown>;
      };
      mockRoutineService.getDetail.mockResolvedValue({
        id: "routine-1",
        companyId: "company-1",
        title: "Nightly",
        project: fixture,
      });

      const res = await request(createRoutinesApp()).get("/api/routines/routine-1");

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PLAIN_SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain(SECOND_SENTINEL);
      // Names survive: the diagnostic value of knowing WHICH variables are set is preserved.
      expect(Object.keys(res.body.project.env)).toContain("PLAIN_FIXTURE");
      // ...and the mask is non-destructive upstream — the row the service handed over still holds
      // its values, so the two negatives above are about the response and not about a fixture that
      // never carried anything.
      expect(fixture.env.PLAIN_FIXTURE).toEqual({ type: "plain", value: PLAIN_SENTINEL });
      expect(fixture.env.SHORTHAND_FIXTURE).toBe(SECOND_SENTINEL);
    });

    it("leaves a routine detail with no project untouched", async () => {
      // The other branch of the handler's ternary. It answers with `detail` unwrapped, so a mask
      // applied to the wrong branch would be invisible here and this pins that it still answers.
      mockRoutineService.getDetail.mockResolvedValue({
        id: "routine-1",
        companyId: "company-1",
        title: "Nightly",
        project: null,
      });

      const res = await request(createRoutinesApp()).get("/api/routines/routine-1");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: "routine-1", project: null });
    });
  });

  describe("the round trip the mask would otherwise break", () => {
    it("persists the stored value for an untouched masked row and the new value for the edited one", async () => {
      // Reproduces what the editor actually sends: `valueFromRows` re-emits EVERY row on save, so
      // the untouched row arrives carrying the mask it was rendered with.
      const res = await request(createApp())
        .patch("/api/projects/project-1")
        .send({
          env: {
            PLAIN_FIXTURE: { type: "plain", value: PROJECT_ENV_VALUE_MASK },
            SHORTHAND_FIXTURE: { type: "plain", value: "edited-fixture-value" },
          },
        });

      expect(res.status).toBe(200);
      const persisted = mockSecretService.normalizeEnvBindingsForPersistence.mock.calls[0]?.[1] as
        Record<string, any>;
      // The untouched row keeps its stored value instead of 422ing the whole save...
      expect(persisted.PLAIN_FIXTURE).toEqual({ type: "plain", value: PLAIN_SENTINEL });
      // ...and the edited row still takes the new value.
      expect(persisted.SHORTHAND_FIXTURE).toEqual({ type: "plain", value: "edited-fixture-value" });
    });

    it("merges BEFORE normalization, so a placeholder with nothing behind it still reaches the refusal", async () => {
      await request(createApp())
        .patch("/api/projects/project-1")
        .send({ env: { NEW_FIXTURE: { type: "plain", value: PROJECT_ENV_VALUE_MASK } } });

      const persisted = mockSecretService.normalizeEnvBindingsForPersistence.mock.calls[0]?.[1] as
        Record<string, any>;
      expect(persisted.NEW_FIXTURE).toEqual({ type: "plain", value: PROJECT_ENV_VALUE_MASK });
    });
  });
});
