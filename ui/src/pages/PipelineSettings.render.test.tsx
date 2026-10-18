// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PipelineSettings } from "./PipelineSettings";
import { flushReact, waitForAssertion } from "@/test-utils/react";

/**
 * Tripwire for the env-editor submit guard's only live surface.
 *
 * `EnvironmentVariablesEditor` installs its capture-phase `submit` listener
 * only when `editorRootRef.current.closest("form")` resolves
 * (`components/environment-variables-editor/index.tsx`, the
 * `form.addEventListener("submit", handleSubmit, true)` effect). That listener
 * is what stops a refused masked rename from riding along with an outer save —
 * the silent partial-save class PEN-3358 closed.
 *
 * Exactly one in-repo consumer satisfies it, and it does so by DOM nesting
 * across two files: the Pipelines stage editor's `<form>` in
 * `PipelineSettings.tsx` wraps `<StageSecretsPanel>`, which renders the editor.
 * Nothing else in `src/` puts the editor under a form — the other five
 * consumers (AgentConfigForm, ProjectProperties, routine editable-sections,
 * CompanyEnvironments, DesignGuide) and their parent pages are plain `div`s.
 *
 * The coverage inside `EnvironmentVariablesEditor.test.tsx` is a *synthetic*
 * `<form>` harness: it passes whether or not any real consumer is shaped that
 * way. So refactoring this page's stage editor from `<form onSubmit>` to a
 * `<div>` + click handler — a reasonable change, and the direction the rest of
 * this codebase has gone — would kill the guard on its only live surface with
 * the whole suite still green. This test renders the real page and asserts the
 * nesting, so that refactor goes red here instead.
 *
 * Before deleting this: confirm either that the editor no longer depends on a
 * `<form>` ancestor to install the listener, or that some other consumer
 * provides one and is itself pinned. See PEN-4260, and the submission-scope
 * doc block above that effect in the editor itself.
 */

const mockPipelinesApi = vi.hoisted(() => ({
  get: vi.fn(),
  getHealth: vi.fn(),
  list: vi.fn(),
  listCases: vi.fn(),
  getIntakeForm: vi.fn(),
  getDocument: vi.fn(),
  listCompanyCaseEvents: vi.fn(),
  update: vi.fn(),
  updateStage: vi.fn(),
  createStage: vi.fn(),
  deleteStage: vi.fn(),
  setTransitions: vi.fn(),
  updateStageAutomationEnv: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAccessApi = vi.hoisted(() => ({ listUserDirectory: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockProjectsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));
const mockExecutionWorkspacesApi = vi.hoisted(() => ({ listSummaries: vi.fn() }));
const mockSidebarPreferencesApi = vi.hoisted(() => ({
  getProjectOrder: vi.fn(),
  setProjectOrder: vi.fn(),
}));

// `importOriginal` spreads keep every *other* export of these modules intact —
// the page's type-only imports and sibling components pull from them too.
vi.mock("@/api/pipelines", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pipelinesApi: mockPipelinesApi,
}));
vi.mock("@/api/agents", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  agentsApi: mockAgentsApi,
}));
vi.mock("@/api/access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  accessApi: mockAccessApi,
}));
vi.mock("@/api/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authApi: mockAuthApi,
}));
vi.mock("@/api/projects", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  projectsApi: mockProjectsApi,
}));
vi.mock("@/api/secrets", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  secretsApi: mockSecretsApi,
}));
vi.mock("@/api/instanceSettings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  instanceSettingsApi: mockInstanceSettingsApi,
}));
vi.mock("@/api/execution-workspaces", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));
vi.mock("@/api/sidebarPreferences", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

// The stage Instructions tab's MarkdownEditor drags in @mdxeditor/editor →
// @codesandbox/sandpack-react, whose stitches marker rule (`--sxs{--sxs:N}`)
// jsdom's CSS parser rejects at module-eval time (same graph hazard as
// App.cases-routing.test.tsx). The Secrets tab never renders it.
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: () => null,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
  useToastActions: () => ({ pushToast: vi.fn() }),
  useOptionalToastActions: () => ({ pushToast: vi.fn() }),
}));

// Minimal browser APIs for jsdom (radix primitives on the page measure).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const STAGE_ID = "stage-working-1";
const SETTINGS_PATH = "/pipelines/:pipelineId/settings";

function pipelineDetail() {
  return {
    id: "pipeline-1",
    companyId: "company-1",
    key: "content",
    name: "Content",
    description: null,
    projectId: null,
    enforceTransitions: false,
    archivedAt: null,
    stageCount: 1,
    openCaseCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    transitions: [],
    stages: [
      {
        id: STAGE_ID,
        pipelineId: "pipeline-1",
        key: "drafting",
        name: "Drafting",
        kind: "working",
        position: 0,
        // The Secrets tab renders the editor only for a stage with a backing
        // automation routine AND an assignee (`StageSecretsPanel.hasAutomation`);
        // without both it renders an EmptyState and there is no editor to find.
        config: {
          automation: {
            routineId: "routine-1",
            assigneeAgentId: "agent-1",
            env: {},
          },
        },
      },
    ],
  };
}

function renderPipelineSettings(queryClient: QueryClient, initialPath: string) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>
          <Routes>
            <Route path={SETTINGS_PATH} element={<PipelineSettings />} />
          </Routes>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mockPipelinesApi.get.mockResolvedValue(pipelineDetail());
  mockPipelinesApi.getHealth.mockResolvedValue({ warnings: [] });
  mockPipelinesApi.list.mockResolvedValue([]);
  mockPipelinesApi.listCases.mockResolvedValue([]);
  mockPipelinesApi.getIntakeForm.mockResolvedValue(null);
  mockPipelinesApi.getDocument.mockResolvedValue(null);
  mockPipelinesApi.listCompanyCaseEvents.mockResolvedValue([]);
  mockAgentsApi.list.mockResolvedValue([
    { id: "agent-1", companyId: "company-1", name: "Writer", role: "writer", status: "idle" },
  ]);
  mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
  mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mockProjectsApi.list.mockResolvedValue([]);
  mockSecretsApi.list.mockResolvedValue([]);
  mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
  mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
  mockSidebarPreferencesApi.getProjectOrder.mockResolvedValue({ projectIds: [] });

  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function renderSecretsSection() {
  root = createRoot(container!);
  await act(async () => {
    root!.render(renderPipelineSettings(
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      `/pipelines/pipeline-1/settings?stage=${STAGE_ID}&section=secrets`,
    ));
  });
  await flushReact(3);
}

async function findEditorRoot(): Promise<HTMLElement> {
  let editor: HTMLElement | null = null;
  // Positive control: if the editor never rendered, say so here rather than
  // letting a vacuous `closest` result read as a passing invariant.
  await waitForAssertion(() => {
    editor = document.body.querySelector<HTMLElement>("[data-testid='environment-variables-editor']");
    expect(editor, "stage Secrets tab did not render EnvironmentVariablesEditor").not.toBeNull();
  });
  return editor!;
}

describe("PipelineSettings stage editor — env-editor submit scope", () => {
  it("renders the stage Secrets editor inside a <form>", async () => {
    await renderSecretsSection();
    const editor = await findEditorRoot();

    expect(
      editor.closest("form"),
      "EnvironmentVariablesEditor is no longer inside a <form>; its capture-phase submit guard is dead on its only live surface",
    ).not.toBeNull();
  });

  it("scopes the editor to the form whose submit saves the stage", async () => {
    await renderSecretsSection();
    const editor = await findEditorRoot();
    const scope = editor.closest("form");
    expect(scope).not.toBeNull();

    // `closest("form")` finding *a* form is not enough — the guard only earns
    // its keep if that form's submit is the stage save it needs to veto. The
    // "Save stage" button itself is behind the dirty-state sticky footer, so
    // drive the submit the button would drive and watch for the write.
    await act(async () => {
      scope!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact(2);

    expect(
      mockPipelinesApi.updateStage,
      "the form wrapping the env editor does not save the stage; the submit guard now vetoes the wrong thing",
    ).toHaveBeenCalled();
    expect(mockPipelinesApi.updateStage.mock.calls[0]?.slice(0, 2)).toEqual(["pipeline-1", STAGE_ID]);
  });
});
