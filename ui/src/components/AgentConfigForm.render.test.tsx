// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL, type Agent, type Environment } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentConfigForm } from "./AgentConfigForm";
import { defaultCreateValues } from "./agent-config-defaults";

const mockAgentsApi = vi.hoisted(() => ({
  adapterModelProfiles: vi.fn(),
  adapterModels: vi.fn(),
  detectModel: vi.fn(),
  list: vi.fn(),
  testEnvironment: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
    selectionSource: "bootstrap",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../adapters", () => ({
  getUIAdapter: (type: string) => ({
    type,
    label: type === "hermes_gateway" ? "Hermes Gateway" : "Codex",
    ConfigFields: ({ adapterType }: { adapterType: string }) =>
      adapterType === "hermes_gateway"
        ? <div data-testid="hermes-gateway-config-fields">Hermes Gateway fields</div>
        : null,
    buildAdapterConfig: (values: { model?: string }) => ({
      model: values.model || undefined,
    }),
    parseStdoutLine: () => [],
  }),
}));

vi.mock("../adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => (adapterType: string) =>
    adapterType === "hermes_gateway"
      ? {
          supportsInstructionsBundle: false,
          supportsSkills: false,
          supportsLocalAgentJwt: false,
          requiresMaterializedRuntimeSkills: false,
          supportsModelProfiles: false,
          supportsAcp: false,
        }
      : {
          supportsInstructionsBundle: true,
          supportsSkills: true,
          supportsLocalAgentJwt: true,
          requiresMaterializedRuntimeSkills: false,
          supportsModelProfiles: true,
          supportsAcp: true,
        },
}));

vi.mock("../adapters/use-disabled-adapters", () => ({
  useDisabledAdaptersSync: () => [],
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder ?? "Markdown"}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Cody",
    role: "Engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as Agent;
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Local",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Matches `AgentConfigFormProps["onSave"]` in edit mode. */
type AgentSaveHandler = (patch: Record<string, unknown>) => void | Promise<unknown>;
type AgentSaveSpy = ReturnType<typeof vi.fn<AgentSaveHandler>>;

async function renderForm(
  environments: Environment[],
  agentOverrides: Partial<Agent> = {},
  options: {
    showAdapterTestEnvironmentButton?: boolean;
    /** Spy for the edit-mode save. Defaults to a fresh spy; returned as `onSave`. */
    onSave?: AgentSaveSpy;
    /** Hide the built-in sticky Save, as a parent toolbar owning the save action does. */
    hideInlineSave?: boolean;
    /**
     * Register `onTestActionChange` so the test can invoke the adapter test programmatically.
     * Opt-in because supplying the callback at all hides the form's own inline Test button
     * (`AgentConfigForm.tsx` — `showInlineAdapterTestEnvironmentButton`), which the DOM-driven
     * tests in this file rely on.
     */
    captureTestAction?: boolean;
  } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const onSave: AgentSaveSpy = options.onSave ?? vi.fn<AgentSaveHandler>();
  // The save action AgentConfigForm registers with a parent toolbar. Captured so a test can invoke
  // the real `handleSave` without going through a DOM click near the editor — the path a parent
  // that owns its own Save button takes, and the only path the editor's capture-phase listeners
  // cannot see.
  const saveAction: { current: (() => void) | null } = { current: null };
  /** Same idea for the adapter test action a parent toolbar owns. */
  const testAction: { current: (() => void) | null } = { current: null };

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="edit"
            agent={makeAgent(agentOverrides)}
            onSave={onSave}
            onSaveActionChange={(save) => {
              saveAction.current = save;
            }}
            onTestActionChange={options.captureTestAction ? (test) => {
              testAction.current = test;
            } : undefined}
            hideInlineSave={options.hideInlineSave ?? false}
            hidePromptTemplate
            showAdapterTypeField={false}
            showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onSave, saveAction, testAction };
}

async function renderCreateForm(
  environments: Environment[],
  valueOverrides: Partial<typeof defaultCreateValues> = {},
  options: { showAdapterTestEnvironmentButton?: boolean } = {},
) {
  mockEnvironmentsApi.list.mockResolvedValue(environments);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const values = {
    ...defaultCreateValues,
    adapterType: "codex_local",
    ...valueOverrides,
  };
  const onChange = vi.fn();

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="create"
            values={values}
            onChange={onChange}
            hidePromptTemplate
            showAdapterTypeField={false}
            showAdapterTestEnvironmentButton={options.showAdapterTestEnvironmentButton ?? false}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });

  await flushReact();
  return { container, root, onChange };
}

describe("AgentConfigForm environment selector", () => {
  let roots: Root[] = [];

  beforeEach(() => {
    mockAgentsApi.adapterModelProfiles.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAgentsApi.detectModel.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.testEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableEnvironments: true });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({ executionMode: "any" });
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount();
      });
    }
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides the environment override when Local is the only configured environment", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ]);
    roots.push(result.root);

    expect(result.container.textContent).not.toContain("Environment override");
    expect(result.container.querySelector("select")).toBeNull();
  });

  it("shows concise Environment copy when one runnable non-local environment exists", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
      makeEnvironment({
        id: "sandbox-1",
        name: "E2B",
        driver: "sandbox",
        config: { provider: "e2b" },
      }),
    ]);
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment");
    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("E2B · sandbox");
    expect(text).not.toContain("Execution");
    expect(text).not.toContain("Leave this unset to inherit the instance default");
    expect(text).not.toContain("Inherit instance default");
  });

  it("shows the environment override for Grok local agents", async () => {
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "sandbox-1",
          name: "E2B",
          driver: "sandbox",
          config: { provider: "e2b" },
        }),
      ],
      { adapterType: "grok_local" },
    );
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("E2B · sandbox");
  });

  it("keeps an existing non-runnable override visible so it can be cleared", async () => {
    const result = await renderForm(
      [
        makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
        makeEnvironment({
          id: "fake-sandbox-1",
          name: "Fake Sandbox",
          driver: "sandbox",
          config: { provider: "fake" },
        }),
      ],
      { defaultEnvironmentId: "fake-sandbox-1" },
    );
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    const selector = result.container.querySelector("select");

    expect(text).toContain("Environment override");
    expect(selector?.textContent).toContain("Default: Local");
    expect(selector?.textContent).toContain("Fake Sandbox · sandbox");
  });

  it("renders non-local adapter config fields in the Adapter card", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      {
        adapterType: "hermes_gateway",
        adapterConfig: {
          apiBaseUrl: "http://127.0.0.1:8642",
          apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
        },
      },
    );
    roots.push(result.root);

    expect(result.container.querySelector('[data-testid="hermes-gateway-config-fields"]')).toBeTruthy();
    expect(result.container.textContent).toContain("Hermes Gateway fields");
  });

  it("tests both the primary and cheap models when a cheap profile is configured", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: {
              model: "gpt-5.4-mini",
              baseUrl: "https://cheap-models.example.test",
              provider: "budget-provider",
            },
          },
        },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(2);
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: expect.objectContaining({ model: "gpt-5.4" }),
    });
    expect(mockAgentsApi.testEnvironment.mock.calls[1]?.[2]).toMatchObject({
      adapterConfig: expect.objectContaining({
        model: "gpt-5.4-mini",
        baseUrl: "https://cheap-models.example.test",
        provider: "budget-provider",
      }),
    });
  });

  it("tests a Codex agent after clearing the primary model to the adapter default", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const modelButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "gpt-5.4",
    );
    expect(modelButton).toBeTruthy();

    await act(async () => {
      modelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const defaultButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Default",
    );
    expect(defaultButton).toBeTruthy();

    await act(async () => {
      defaultButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: {},
    });
    const adapterConfig = (mockAgentsApi.testEnvironment.mock.calls[0]?.[2] as {
      adapterConfig: Record<string, unknown>;
    }).adapterConfig;
    expect(adapterConfig).not.toHaveProperty("model");
    expect(result.container.textContent).not.toContain("Cannot read properties of undefined");
  });

  it("omits undefined adapter config entries when testing a create form with the default model", async () => {
    const result = await renderCreateForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      model: "",
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
    expect(mockAgentsApi.testEnvironment.mock.calls[0]?.[2]).toMatchObject({
      adapterConfig: {},
    });
    const adapterConfig = (mockAgentsApi.testEnvironment.mock.calls[0]?.[2] as {
      adapterConfig: Record<string, unknown>;
    }).adapterConfig;
    expect(adapterConfig).not.toHaveProperty("model");
  });

  it("flushes pending environment variable edits before testing adapter config", async () => {
    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: {
        model: "gpt-5.4",
        env: { API_TOKEN: { type: "plain", value: "old-token" } },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const valueInput = result.container.querySelector<HTMLInputElement>('input[aria-label="Variable value"]');
    expect(valueInput).toBeTruthy();

    await act(async () => {
      setInputValue(valueInput!, "draft-token");
    });
    await flushReact();

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalled();
    for (const call of mockAgentsApi.testEnvironment.mock.calls) {
      expect(call).toEqual([
        "company-1",
        "codex_local",
        expect.objectContaining({
          adapterConfig: expect.objectContaining({
            env: { API_TOKEN: { type: "plain", value: "draft-token" } },
          }),
        }),
      ]);
    }
  });

  // ---- PEN-3358: a refused env draft must abort the outer action, not be saved around ----
  //
  // `flushPendingDraft` used to answer `null` both for "nothing to promote" and for "there are
  // changes and I refuse them". Both ref-handle consumers read that single value as the former, so
  // a refusal let the outer action proceed on the *last committed* env — a partial save the user
  // was never told about. These two tests pin the two ways an outer action reaches the editor.

  /** An agent whose stored env carries a server-masked value, plus one ordinary variable. */
  const maskedEnvAgent = {
    adapterConfig: {
      model: "gpt-5.4",
      env: {
        GH_TOKEN: { type: "plain", value: REDACTED_SENTINEL },
        NODE_ENV: { type: "plain", value: "production" },
      },
    },
  } satisfies Partial<Agent>;

  /** Rename the masked row off the key its mask was issued under — the refusal trigger. */
  async function renameMaskedRow(container: HTMLElement, to: string) {
    const nameInput = container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable name"]')[0];
    expect(nameInput, "the masked row's name field must be present").toBeTruthy();
    await act(async () => {
      setInputValue(nameInput!, to);
    });
    await flushReact();
  }

  it("refuses an adapter-config test while a withheld env row is renamed, instead of testing stale env (PEN-3358)", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      maskedEnvAgent,
      { showAdapterTestEnvironmentButton: true },
    );
    roots.push(result.root);

    await renameMaskedRow(result.container, "GITHUB_TOKEN");

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    // The sibling test above ("flushes pending environment variable edits before testing adapter
    // config") proves this same button DOES reach `testEnvironment` with the promoted draft when
    // the editor is not refusing — so this assertion is about the refusal, not about the button
    // being inert in general.
    expect(
      mockAgentsApi.testEnvironment,
      "a refused env draft must abort the test, not test the pre-edit env",
    ).not.toHaveBeenCalled();

    // And the refusal has to be legible, naming the row that caused it.
    expect(result.container.textContent).toContain("Can't save");
    expect(result.container.textContent).toContain("GH_TOKEN");
  });

  it("refuses a programmatic adapter test while a withheld env row is renamed (PEN-3358)", async () => {
    // The DOM-click version of this above is also covered by the editor's outside-Save click
    // listener, so it does not pin the guard inside `testEnvironment`'s `mutationFn`. Invoking the
    // registered test action directly bypasses every DOM listener and leaves only that guard.
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      maskedEnvAgent,
      { showAdapterTestEnvironmentButton: true, captureTestAction: true },
    );
    roots.push(result.root);

    await renameMaskedRow(result.container, "GITHUB_TOKEN");

    expect(result.testAction.current, "the form must register a test action").toBeTruthy();
    await act(async () => {
      result.testAction.current?.();
    });
    await flushReact();

    expect(
      mockAgentsApi.testEnvironment,
      "a refused env draft must abort the adapter test, not test the pre-edit env",
    ).not.toHaveBeenCalled();
    // And the refusal reaches the user through the form's own error surface.
    expect(result.container.textContent).toContain("Can't save");
  });

  it("refuses a programmatic Save while a withheld env row is renamed, then saves once the block lifts (PEN-3358)", async () => {
    const result = await renderForm(
      [makeEnvironment({ id: "local-1", name: "Local", driver: "local" })],
      maskedEnvAgent,
      // No inline Save: the parent toolbar owns it and calls the registered action directly. This
      // is the path the editor's capture-phase listeners cannot intercept, so it isolates the
      // consumer-side guard in `AgentConfigForm.handleSave`.
      { hideInlineSave: true },
    );
    roots.push(result.root);

    // Dirty a NON-env field as well. This is what makes the bug a *partial save* rather than a
    // no-op: under the old code the refusal fell through to `overlay`, which carries this name
    // change, so `onSave` fired with the new name and the pre-edit env — reported as a success.
    const nameField = result.container.querySelector<HTMLInputElement>('input[placeholder="Agent name"]');
    expect(nameField, "the identity Name field must be present").toBeTruthy();
    await act(async () => {
      setInputValue(nameField!, "Cody Renamed");
    });
    await flushReact();

    await renameMaskedRow(result.container, "GITHUB_TOKEN");

    expect(result.saveAction.current, "the form must register a save action").toBeTruthy();
    await act(async () => {
      result.saveAction.current?.();
    });
    await flushReact();

    expect(
      result.onSave,
      "a refused env draft must abort the whole save, not save the other fields around it",
    ).not.toHaveBeenCalled();

    // Re-entering a value makes the rename legitimate. The block must lift rather than latch —
    // without this the test would also pass against a form that simply never saves.
    const maskedValue = result.container.querySelectorAll<HTMLInputElement>('input[aria-label="Variable value"]')[0];
    expect(maskedValue).toBeTruthy();
    await act(async () => {
      setInputValue(maskedValue!, "a-new-token");
    });
    await flushReact();

    await act(async () => {
      result.saveAction.current?.();
    });
    await flushReact();

    expect(result.onSave, "the save must go through once the row is no longer blocking").toHaveBeenCalledTimes(1);
    const patch = result.onSave.mock.calls[0]![0] as Record<string, unknown>;
    const adapterConfig = patch.adapterConfig as Record<string, unknown> | undefined;
    expect(adapterConfig?.env, "and must carry the renamed binding, not the pre-edit env").toEqual({
      GITHUB_TOKEN: { type: "plain", value: "a-new-token" },
      NODE_ENV: { type: "plain", value: "production" },
    });
    expect(patch.name, "and must still carry the non-env edit").toBe("Cody Renamed");
  });

  it("surfaces request failures instead of converting them into model test checks", async () => {
    mockAgentsApi.testEnvironment.mockRejectedValueOnce(new Error("Network unavailable"));

    const result = await renderForm([
      makeEnvironment({ id: "local-1", name: "Local", driver: "local" }),
    ], {
      adapterConfig: { model: "gpt-5.4" },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            adapterConfig: { model: "gpt-5.4-mini" },
          },
        },
      },
    }, {
      showAdapterTestEnvironmentButton: true,
    });
    roots.push(result.root);

    const testButton = Array.from(result.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Test",
    );
    expect(testButton).toBeTruthy();

    await act(async () => {
      testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.testEnvironment).toHaveBeenCalledTimes(1);
    expect(result.container.textContent).toContain("Network unavailable");
  });
});
