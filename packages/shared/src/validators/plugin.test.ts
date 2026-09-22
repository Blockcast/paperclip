import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import { pluginManagedRoutineDeclarationSchema, pluginManifestV1Schema, pluginUiSlotDeclarationSchema } from "./plugin.js";

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });
});

describe("plugin manifest validators", () => {
  it("accepts existing-style plugins that do not request access or authorization capabilities", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.compat-dashboard",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Compat Dashboard",
      description: "Dashboard-only plugin without access or authorization host APIs.",
      author: "Paperclip",
      categories: ["ui"],
      capabilities: ["ui.dashboardWidget.register"],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui.js",
      },
      ui: {
        slots: [
          {
            type: "dashboardWidget",
            id: "compat-dashboard",
            displayName: "Compat Dashboard",
            exportName: "CompatDashboard",
          },
        ],
      },
    });

    expect(parsed.capabilities).toEqual(["ui.dashboardWidget.register"]);
  });

  it("accepts sandbox provider template config bindings", () => {
    const parsed = pluginManifestV1Schema.parse({
      id: "paperclip.template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Template Provider",
      description: "Sandbox provider with captured template config binding.",
      author: "Paperclip",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "template-provider",
          kind: "sandbox_provider",
          displayName: "Template Provider",
          supportsTemplateCapture: true,
          templateRefKind: "provider_template",
          templateConfigBinding: {
            field: "templateId",
            unsetFields: ["image"],
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.environmentDrivers?.[0]?.templateConfigBinding).toEqual({
      field: "templateId",
      unsetFields: ["image"],
    });
  });

  it("rejects template config bindings that replace provider identity", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      id: "paperclip.bad-template-provider",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Bad Template Provider",
      categories: ["automation"],
      capabilities: ["environment.drivers.register"],
      entrypoints: { worker: "./dist/worker.js" },
      environmentDrivers: [
        {
          driverKey: "bad-template-provider",
          kind: "sandbox_provider",
          displayName: "Bad Template Provider",
          templateConfigBinding: {
            field: "provider",
          },
          configSchema: { type: "object" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("provider key"))).toBe(true);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

describe("plugin UI slot validators", () => {
  it("accepts route-scoped sidebar slots with a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
      routePath: "wiki",
    });

    expect(parsed.routePath).toBe("wiki");
  });

  it("requires route-scoped sidebar slots to declare a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("routeSidebar slots require routePath");
  });

  it("keeps reserved company route protection for route-scoped sidebars", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "settings-route-sidebar",
      displayName: "Settings Sidebar",
      exportName: "SettingsSidebar",
      routePath: "settings",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });

  it("accepts workspace entity types as detailTab targets", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "detailTab",
      id: "workspace-diff-viewer",
      displayName: "Diff",
      exportName: "WorkspaceDiffViewer",
      entityTypes: ["execution_workspace", "project_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace", "project_workspace"]);
  });

  it("accepts execution_workspace as a toolbarButton entityType", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "toolbarButton",
      id: "workspace-open-diff",
      displayName: "Open diff",
      exportName: "OpenWorkspaceDiffButton",
      entityTypes: ["execution_workspace"],
    });

    expect(parsed.entityTypes).toEqual(["execution_workspace"]);
  });

  it("accepts company settings page slots with a non-core settings route", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "companySettingsPage",
      id: "permissions-settings",
      displayName: "Permissions",
      exportName: "PermissionsSettingsPage",
      routePath: "permissions",
    });

    expect(parsed.routePath).toBe("permissions");
  });

  it("prevents company settings page slots from shadowing core settings routes", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "companySettingsPage",
      id: "instance-settings",
      displayName: "Instance",
      exportName: "InstanceSettingsPage",
      routePath: "instance",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });
});

// PEN-2799 — `metricLabels` chooses which of a plugin's metric tag keys may be
// promoted to Prometheus labels. Validated for shape and bounded in count here;
// which keys the host actually promotes is the host's allow-list decision, so a
// manifest naming an unlisted key stays VALID and simply promotes nothing.
describe("plugin manifest metricLabels (PEN-2799)", () => {
  const base = {
    id: "paperclip.metric-labels-fixture",
    apiVersion: 1 as const,
    version: "0.1.0",
    displayName: "Metric Labels Fixture",
    description: "Fixture exercising the metricLabels manifest field.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["metrics.write"],
    entrypoints: { worker: "./dist/worker.js" },
  };

  it("is optional — omitting it leaves metricLabels undefined, not an error", () => {
    const parsed = pluginManifestV1Schema.parse({ ...base });
    expect(parsed.metricLabels).toBeUndefined();
  });

  it("accepts an empty array (declare nothing explicitly)", () => {
    expect(pluginManifestV1Schema.parse({ ...base, metricLabels: [] }).metricLabels).toEqual([]);
  });

  it("accepts snake_case keys and preserves order", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...base,
      metricLabels: ["alertname", "severity", "version"],
    });
    expect(parsed.metricLabels).toEqual(["alertname", "severity", "version"]);
  });

  it("accepts a key the host does not promote — validity is not promotability", () => {
    expect(
      pluginManifestV1Schema.parse({ ...base, metricLabels: ["command_name"] }).metricLabels,
    ).toEqual(["command_name"]);
  });

  it("accepts exactly 5 keys and rejects a 6th", () => {
    const five = ["alertname", "severity", "source", "action", "decision"];
    expect(pluginManifestV1Schema.parse({ ...base, metricLabels: five }).metricLabels).toEqual(five);
    expect(() =>
      pluginManifestV1Schema.parse({ ...base, metricLabels: [...five, "scope"] }),
    ).toThrow();
  });

  it("rejects duplicates — a duplicate would silently consume one of the 5 slots", () => {
    expect(() =>
      pluginManifestV1Schema.parse({ ...base, metricLabels: ["alertname", "alertname"] }),
    ).toThrow(/duplicate/i);
  });

  for (const bad of ["Alertname", "alert-name", "alert.name", "1alert", "_alert", "alert name", ""]) {
    it(`rejects the non-snake_case key ${JSON.stringify(bad)}`, () => {
      expect(() => pluginManifestV1Schema.parse({ ...base, metricLabels: [bad] })).toThrow();
    });
  }

  it("rejects a key longer than 40 chars", () => {
    expect(() =>
      pluginManifestV1Schema.parse({ ...base, metricLabels: [`a${"b".repeat(40)}`] }),
    ).toThrow();
  });

  it("rejects a non-array value", () => {
    expect(() =>
      pluginManifestV1Schema.parse({ ...base, metricLabels: "alertname" }),
    ).toThrow();
  });
});
