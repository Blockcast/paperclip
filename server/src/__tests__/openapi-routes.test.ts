import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agent-image-bump.ts": "/api",
  "agents.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "built-in-agents.ts": "/api",
  "cloud-upstreams.ts": "/api",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "company-skill-policy.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "decision-training.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "github-webhook.ts": "/api/webhooks/github",
  "health.ts": "/api/health",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "linear-auth.ts": "/api/auth/linear",
  "llms.ts": "/api",
  "metrics-ingest.ts": "/api",
  "milestones.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "resource-memberships.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "summary-slots.ts": "/api",
  "teams-catalog.ts": "/api",
  "tool-access.ts": "/api",
  "tool-gateway.ts": "/api",
  "user-profiles.ts": "/api",
  "workspace-scan.ts": "/api",
};

// Captures the first argument of every route registration, whatever form it takes:
// a quoted literal, a path constant, or something this scanner cannot resolve. The
// unresolved case is surfaced rather than skipped — a silently-dropped registration
// would leave the guard audit below with a blind spot that its vacuity check, which
// only counts what the scanner did find, cannot detect.
const ROUTE_REGISTRATION_PATTERN = /router\.(get|post|put|patch|delete)\(\s*([^,)\s]+)/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
// `export const SOME_PATH = "/literal"` in the routes directory. Deliberately
// excludes template literals, which can interpolate and so have no static value.
const EXPORTED_PATH_CONSTANT_PATTERN = /export const ([A-Za-z_$][\w$]*)\s*=\s*["']([^"'`]+)["']/g;
const QUOTED_LITERAL_PATTERN = /^["'`]([^"'`]*)["'`]$/;
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const explicitOpenApiCoverageExclusions = new Set([
  // Pipeline routes are experimental and not yet represented in the public OpenAPI document.
  "pipelines.ts",
  // Case routes are experimental (enableCases flag) and not yet in the public OpenAPI document.
  "cases.ts",
  // Smoke lab routes are experimental and not yet represented in the public OpenAPI document.
  "smoke-lab.ts",
]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

function normalizeExpressPath(routePath: string) {
  return routePath
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if (file === "tool-gateway.ts" && routePath.startsWith("/mcp/gateways/")) {
    return routePath;
  }
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

function routeSourceFiles() {
  return fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"));
}

// `IDENT -> "/literal"` for every statically-valued path constant exported from the
// routes directory, so `router.post(COMPANY_IMPORT_ROUTE_PATH, ...)` resolves without
// a hand-maintained special case. Excluded files are still scanned for constants —
// a constant may live in a file whose own routes are out of OpenAPI scope.
function loadExportedPathConstants() {
  const constants = new Map<string, string>();

  for (const file of routeSourceFiles()) {
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    for (const match of source.matchAll(EXPORTED_PATH_CONSTANT_PATTERN)) {
      constants.set(match[1], match[2]);
    }
  }

  return constants;
}

function resolveRouteArgument(rawArgument: string, constants: Map<string, string>) {
  const literal = QUOTED_LITERAL_PATTERN.exec(rawArgument);
  if (literal) return literal[1];
  return constants.get(rawArgument) ?? null;
}

type RouteRegistration = {
  key: string;
  /**
   * Source from this registration to the next one in the same file. Used to attribute
   * guard calls to a route; a helper declared between two registrations would attach
   * to the preceding one, which shows up as a false positive (a loud failure) rather
   * than a silent miss.
   */
  segment: string;
};

/**
 * Single inventory of the route registrations found in the route sources, shared by
 * the OpenAPI coverage test and the instance-admin guard audit so both see exactly
 * the same set of routes.
 */
function loadRouteRegistrations() {
  const constants = loadExportedPathConstants();
  const registrations: RouteRegistration[] = [];
  const unresolvedRegistrations: string[] = [];
  const unknownRouteFiles: string[] = [];

  for (const file of routeSourceFiles()) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    const matches = [...source.matchAll(ROUTE_REGISTRATION_PATTERN)];
    matches.forEach((match, index) => {
      const start = match.index ?? 0;
      const end = index + 1 < matches.length ? (matches[index + 1].index ?? source.length) : source.length;
      const routePath = resolveRouteArgument(match[2], constants);
      if (routePath === null) {
        unresolvedRegistrations.push(`${file}: router.${match[1]}(${match[2]}`);
        return;
      }

      const method = match[1].toUpperCase();
      registrations.push({
        key: `${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`,
        segment: source.slice(start, end),
      });
    });
  }

  return {
    registrations,
    unresolvedRegistrations: unresolvedRegistrations.sort(),
    unknownRouteFiles: unknownRouteFiles.sort(),
  };
}

function loadActualRoutes() {
  const { registrations, unknownRouteFiles } = loadRouteRegistrations();
  return { routes: new Set(registrations.map((registration) => registration.key)), unknownRouteFiles };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<Record<string, Record<string, unknown>>>(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

// Matches a direct `assertInstanceAdmin(req)` / `await assertInstanceAdmin(req)`
// call. The `\s*\)` deliberately excludes the `assertInstanceAdmin(req: Request)`
// declarations, so a route file that defines its own guard is not a false hit.
const INSTANCE_ADMIN_GUARD_PATTERN = /\bassertInstanceAdmin\s*\(\s*req\s*\)/;

// Handlers that reach `assertInstanceAdmin` on only some code paths, so the
// operation as a whole does NOT require instance admin and must stay classified
// `board`. Classifying these would overstate the requirement, which misleads a
// spec-driven consumer just as badly as understating it.
const CONDITIONAL_INSTANCE_ADMIN_OPERATIONS = new Set([
  // access.ts: instance admin is required only to revoke a `bootstrap_ceo` invite.
  "POST /api/invites/{inviteId}/revoke",
]);

// Route handlers that enforce instance admin, derived from the shared registration
// inventory so a route registered through a path constant is audited too.
function loadInstanceAdminGuardedRoutes() {
  const { registrations } = loadRouteRegistrations();
  const guarded = new Set<string>();
  const exempted = new Set<string>();

  for (const registration of registrations) {
    if (!INSTANCE_ADMIN_GUARD_PATTERN.test(registration.segment)) continue;
    if (CONDITIONAL_INSTANCE_ADMIN_OPERATIONS.has(registration.key)) {
      exempted.add(registration.key);
      continue;
    }
    guarded.add(registration.key);
  }

  return { guarded, exempted };
}

describe("openapi routes", () => {
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe("Get the generated OpenAPI document");
    expect(res.body.paths["/api/companies/{companyId}/agents"].get.summary).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe("Create an agent API key");
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(res.body.paths["/mcp/gateways/{gatewayPublicId}"].post.security).toEqual([]);
    expect(res.body.paths["/api/mcp/gateways/{gatewayPublicId}"]).toBeUndefined();
    expect(res.body.paths["/api/companies"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(JSON.stringify(res.body.paths["/api/companies"].post.responses)).not.toContain("candidates");
    expect(res.body.paths["/api/companies/{companyId}/skills/scan-projects"].post.responses["200"].content[
      "application/json"
    ].schema).toMatchObject({
      type: "object",
      properties: {
        candidates: { type: "array" },
      },
      required: expect.arrayContaining(["candidates"]),
    });
    expect(res.body.paths["/api/agents/{id}/keys"].post.requestBody.content["application/json"].schema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    expect(res.body.paths["/api/companies/{companyId}/folders"].post.responses["201"]).toBeDefined();
    expect(res.body.paths["/api/companies/{companyId}/folders/items/move"].post.summary).toBe(
      "Move an item into or out of a folder",
    );
    expect(JSON.stringify(res.body.paths["/api/tool-gateway/tools"].get)).not.toContain("sessionToken");
    expect(JSON.stringify(res.body.paths["/api/tool-gateway/tools/call"].post)).not.toContain("sessionToken");
  });

  it("covers the mounted server routes exactly", () => {
    const { routes: actualRoutes, unknownRouteFiles } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes].filter((route) => !specRoutes.has(route)).sort();
    const extraInSpec = [...specRoutes].filter((route) => !actualRoutes.has(route)).sort();

    expect({ unknownRouteFiles, missingInSpec, extraInSpec }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
    });
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/plugins/install"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    expect(spec.paths["/api/companies/{companyId}/pr-review-queue"].get.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(spec.paths["/api/companies/{companyId}/pr-review-queue"].get["x-paperclip-authorization"]).toEqual({
      actor: "board",
    });
    expect(spec.paths["/api/companies/{companyId}/pr-review-queue"].get.responses["400"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/{companyId}/cost-events"].post.responses["403"]).toBeDefined();
    expect(spec.paths["/api/instance/database-backups"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/invites/{token}/accept"].post.responses["202"]).toBeDefined();
    expect(spec.paths["/api/board-api-keys"].post.responses["201"]).toBeDefined();
    expect(spec.paths["/api/companies/import"].post.responses["202"]).toBeDefined();
  });

  it("resolves every route registration form in the route sources", () => {
    // The guard audit below can only classify routes this scanner resolved, and its
    // vacuity check counts only what was found — so an unresolvable registration form
    // (a builder call, or an interpolated template path) would create a silent blind
    // spot. Fail explicitly instead, naming the registration that needs support.
    const { unresolvedRegistrations, registrations } = loadRouteRegistrations();

    expect(unresolvedRegistrations).toEqual([]);
    expect(registrations.length).toBeGreaterThan(100);
    // Registered as `router.post(COMPANY_IMPORT_ROUTE_PATH, ...)`, so this passes only
    // while path constants really are being resolved rather than skipped.
    expect(registrations.map((registration) => registration.key)).toContain("POST /api/companies/import");
  });

  it("classifies every instance-admin-guarded route as instance_admin", () => {
    const { spec } = loadSpecRoutes();
    const guarded = [...loadInstanceAdminGuardedRoutes().guarded].sort();

    // Guards against the parser silently matching nothing and passing vacuously.
    expect(guarded.length).toBeGreaterThan(10);

    const misclassified = guarded.filter((key) => {
      const separator = key.indexOf(" ");
      const method = key.slice(0, separator).toLowerCase();
      const routePath = key.slice(separator + 1);
      const operation = spec.paths?.[routePath]?.[method] as Record<string, unknown> | undefined;
      const authorization = operation?.["x-paperclip-authorization"] as { instanceAdmin?: boolean } | undefined;
      return authorization?.instanceAdmin !== true;
    });

    expect(misclassified).toEqual([]);
  });

  it("documents instance admin on the plugin config operations", () => {
    const { spec } = loadSpecRoutes();

    // BLO-26526: the routes enforce instance admin, but `BOARD_ONLY_PREFIXES`
    // resolved these to plain `board`, so the spec understated the requirement
    // on the exact endpoints that hold plugin credentials.
    for (const [routePath, method] of [
      ["/api/plugins/{pluginId}/config", "get"],
      ["/api/plugins/{pluginId}/config", "post"],
      ["/api/plugins/{pluginId}/config/test", "post"],
    ] as const) {
      expect(spec.paths[routePath][method]["x-paperclip-authorization"]).toEqual({
        actor: "board",
        instanceAdmin: true,
      });
    }
  });

  it("keeps conditionally-guarded operations out of the instance-admin set", () => {
    const { spec } = loadSpecRoutes();

    // Instance admin is required only for `bootstrap_ceo` invites, so the
    // operation as a whole must not advertise it. Asserted on `instanceAdmin`
    // rather than the whole object so a legitimate change to the base actor
    // level does not masquerade as this regression.
    expect(spec.paths["/api/invites/{inviteId}/revoke"].post["x-paperclip-authorization"]).not.toHaveProperty(
      "instanceAdmin",
    );
  });

  it("keeps every conditional-guard exemption backed by a real route and a real guard", () => {
    // The exemption set is the one way this audit can be weakened, so each entry has
    // to earn its place: it must match a route the scanner actually found, and that
    // route's handler must actually reach `assertInstanceAdmin`. A stale or mistyped
    // key would otherwise sit here silently exempting nothing — or worse, keep
    // exempting a route whose guard has since become unconditional.
    const { exempted } = loadInstanceAdminGuardedRoutes();

    expect([...exempted].sort()).toEqual([...CONDITIONAL_INSTANCE_ADMIN_OPERATIONS].sort());
  });
});
