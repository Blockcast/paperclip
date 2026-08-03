// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { ReviewQueueCard } from "./ReviewQueueCard";

const listActionRequestsMock = vi.hoisted(() => vi.fn());
const approveActionRequestMock = vi.hoisted(() => vi.fn());
const createTrustRuleFromActionRequestMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listActionRequests: (companyId: string, status: string) => listActionRequestsMock(companyId, status),
    approveActionRequest: (companyId: string, actionRequestId: string) =>
      approveActionRequestMock(companyId, actionRequestId),
    createTrustRuleFromActionRequest: (companyId: string, actionRequestId: string, input: unknown) =>
      createTrustRuleFromActionRequestMock(companyId, actionRequestId, input),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function pendingRequest() {
  return {
    request: {
      id: "request-1",
      companyId: "company-1",
      invocationId: "invocation-1",
      issueId: "issue-1",
      interactionId: null,
      approvalId: null,
      status: "pending",
      canonicalArgumentsHash: "hash-1",
      canonicalArgumentsSummary: {},
      signedArguments: "signed",
      previewMarkdown: null,
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      resolvedByAgentId: null,
      resolvedByUserId: null,
      decidedByAgentId: null,
      decidedByUserId: null,
      decidedAt: null,
      expiresAt: null,
      resolvedAt: null,
      createdAt: new Date("2026-06-16T12:00:00Z"),
      updatedAt: new Date("2026-06-16T12:00:00Z"),
    },
    toolName: "send_email",
    toolTitle: "Send email",
    connectionId: "connection-1",
    connectionName: "Mail",
    applicationName: "Mail",
    riskLevel: "write",
    requestedByAgentId: "agent-1",
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function ActiveEmptyReviewCountObserver() {
  const [showReview, setShowReview] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.tools.actionRequests("company-1", "pending"),
    queryFn: () => listActionRequestsMock("company-1", "pending"),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.isSuccess) setShowReview(true);
  }, [query.isSuccess]);

  return showReview ? <ReviewQueueCard emptyState="reassure" /> : null;
}

function ActiveInFlightReviewCountObserver() {
  const [showReview, setShowReview] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.tools.actionRequests("company-1", "pending"),
    queryFn: () => listActionRequestsMock("company-1", "pending"),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (query.fetchStatus === "fetching") setShowReview(true);
  }, [query.fetchStatus]);

  return showReview ? <ReviewQueueCard emptyState="reassure" /> : null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReviewQueueCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listActionRequestsMock.mockResolvedValue({ actionRequests: [pendingRequest()] });
    approveActionRequestMock.mockResolvedValue({ ...pendingRequest().request, status: "approved" });
    createTrustRuleFromActionRequestMock.mockResolvedValue({ id: "policy-1" });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  ) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ReviewQueueCard emptyState="reassure" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("promotes Always allow only after the action request is approved", async () => {
    const calls: string[] = [];
    approveActionRequestMock.mockImplementation(async () => {
      calls.push("approve");
      return { ...pendingRequest().request, status: "approved" };
    });
    createTrustRuleFromActionRequestMock.mockImplementation(async () => {
      calls.push("trust-rule");
      return { id: "policy-1" };
    });
    await render();

    await act(async () => {
      buttonContaining("Always allow")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await flushReact();

    expect(calls).toEqual(["approve", "trust-rule"]);
    expect(approveActionRequestMock).toHaveBeenCalledWith("company-1", "request-1");
    expect(createTrustRuleFromActionRequestMock).toHaveBeenCalledWith(
      "company-1",
      "request-1",
      { approvalThreshold: 1 },
    );
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Always allowed" }));
  });

  it("refetches on mount when a cached empty pending queue is still fresh", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    client.setQueryData(queryKeys.tools.actionRequests("company-1", "pending"), {
      actionRequests: [],
    });

    await render(client);
    await flushReact();

    expect(listActionRequestsMock).toHaveBeenCalledWith("company-1", "pending");
    expect(buttonContaining("Allow once")).toBeTruthy();
  });

  it("refetches on mount when another active observer has fresh empty pending data", async () => {
    listActionRequestsMock
      .mockResolvedValueOnce({ actionRequests: [] })
      .mockResolvedValue({ actionRequests: [pendingRequest()] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ActiveEmptyReviewCountObserver />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(listActionRequestsMock).toHaveBeenCalledTimes(2);
      expect(buttonContaining("Allow once")).toBeTruthy();
    });
  });

  it("waits for an in-flight shared fetch before spending the mount refetch", async () => {
    const firstFetch = deferred<{ actionRequests: ReturnType<typeof pendingRequest>[] }>();
    listActionRequestsMock
      .mockImplementationOnce(() => firstFetch.promise)
      .mockResolvedValue({ actionRequests: [pendingRequest()] });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });

    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ActiveInFlightReviewCountObserver />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(listActionRequestsMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      firstFetch.resolve({ actionRequests: [] });
      await firstFetch.promise;
    });

    await vi.waitFor(() => {
      expect(listActionRequestsMock).toHaveBeenCalledTimes(2);
      expect(buttonContaining("Allow once")).toBeTruthy();
    });
  });

  it("refreshes an empty mounted queue so externally-created pending requests appear", async () => {
    listActionRequestsMock.mockResolvedValue({ actionRequests: [] });

    await render();

    await vi.waitFor(() => {
      expect(listActionRequestsMock).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("Nothing is waiting for your OK right now.");
    });

    listActionRequestsMock.mockResolvedValue({ actionRequests: [pendingRequest()] });

    await vi.waitFor(
      () => {
        expect(listActionRequestsMock).toHaveBeenCalledTimes(3);
        expect(buttonContaining("Allow once")).toBeTruthy();
      },
      { timeout: 3_500 },
    );
  });
});
