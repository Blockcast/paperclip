// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalDetail } from "./ApprovalDetail";
import type { Approval } from "@paperclipai/shared";

// `ApprovalDetail.remediation.test.ts` covers `canResubmitFromBoard` as a
// predicate. It cannot cover the fix: deleting `&& canDriveResubmit` from the
// "Mark resubmitted" condition leaves every one of those tests green, because
// they call the helper directly and never render the page. The helper is pure
// and unlikely to rot; the call site is what a later refactor drops. This file
// pins the call site, so it renders the page and asserts on the button.

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
  setSelectedCompanyId: vi.fn(),
}));

const breadcrumbState = vi.hoisted(() => ({ setBreadcrumbs: vi.fn() }));

const approvalsApiMock = vi.hoisted(() => ({
  get: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  resubmit: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  addComment: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
  useOptionalCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => breadcrumbState }));
vi.mock("../api/approvals", () => ({ approvalsApi: approvalsApiMock }));
vi.mock("../api/agents", () => ({ agentsApi: agentsApiMock }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

const budgetCard = (over: Partial<Approval> = {}): Approval =>
  ({
    id: "approval-1",
    companyId: "company-1",
    type: "budget_override_required",
    status: "revision_requested",
    payload: { title: "Raise the cap" },
    requestedByAgentId: null,
    requestedByUserId: null,
    decisionNote: null,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...over,
  }) as Approval;

async function renderDetail(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ApprovalDetail />
      </QueryClientProvider>,
    );
  });
  return root;
}

const resubmitButton = (container: HTMLDivElement) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Mark resubmitted") ?? null;

describe("ApprovalDetail resubmit affordance", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    approvalsApiMock.listComments.mockResolvedValue([]);
    approvalsApiMock.listIssues.mockResolvedValue([]);
    agentsApiMock.list.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    container.remove();
  });

  // The wiring assertion. Without `&& canDriveResubmit` at the call site this
  // button renders and this test fails — which is the point of the file.
  it("suppresses the button on a caller-filed budget card and explains why", async () => {
    approvalsApiMock.get.mockResolvedValue(budgetCard({ requestedByAgentId: "agent-1" }));
    const root = await renderDetail(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Sent back for revision");
      expect(resubmitButton(container)).toBeNull();
    });

    // The suppression text has to be true for the reader. A board user is the
    // only identity the server's resubmit guard lets through on a card whose
    // `requestedByAgentId` is null, so attributing the capability to "the agent
    // that filed this card" tells the one person who can that they cannot.
    expect(container.textContent).not.toContain("Only the agent");
    expect(container.textContent).toContain("enforcement_assertions");

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the button on a watcher-filed budget card, which the server exempts", async () => {
    approvalsApiMock.get.mockResolvedValue(budgetCard());
    const root = await renderDetail(container);

    await waitForAssertion(() => {
      expect(resubmitButton(container)).not.toBeNull();
    });
    expect(container.textContent).not.toContain("Sent back for revision");

    await act(async () => {
      root.unmount();
    });
  });
});
