import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateIssue } from "../src/linear.js";
import * as sync from "../src/sync.js";

vi.mock("../src/linear.js", () => ({
  getWorkflowStates: vi.fn().mockResolvedValue([]),
  updateIssue: vi.fn().mockResolvedValue({}),
}));

function createCtx() {
  const state = new Map<string, unknown>();
  return {
    state: {
      get: vi.fn(async ({ stateKey }: { stateKey: string }) => state.get(stateKey) ?? null),
      set: vi.fn(async ({ stateKey }: { stateKey: string }, value: unknown) => {
        state.set(stateKey, value);
      }),
      delete: vi.fn(async ({ stateKey }: { stateKey: string }) => {
        state.delete(stateKey);
      }),
    },
    http: {
      fetch: vi.fn(),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as any;
}

function issueLink(overrides: Partial<sync.IssueLink> = {}): sync.IssueLink {
  return {
    paperclipIssueId: "pc-issue-1",
    paperclipCompanyId: "comp-1",
    linearIssueId: "lin-issue-1",
    linearIdentifier: "BLO-1",
    linearUrl: "https://linear.app/blockcast/issue/BLO-1",
    syncDirection: "bidirectional",
    lastSyncAt: "2020-01-01T00:00:00.000Z",
    lastLinearStateType: "started",
    lastCommentSyncAt: null,
    ...overrides,
  };
}

describe("syncToLinear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves the Linear issue to the bound Linear project when Paperclip projectId changes", async () => {
    const ctx = createCtx();
    await sync.createProjectLink(ctx, {
      paperclipProjectId: "pc-project-b",
      paperclipCompanyId: "comp-1",
      linearProjectId: "lin-project-b",
      linearProjectName: "Project B",
      linearState: "started",
      syncDirection: "bidirectional",
    });

    await sync.syncToLinear(
      ctx,
      issueLink(),
      { projectId: "pc-project-b" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-issue-1",
      { projectId: "lin-project-b" },
    );
  });

  it("clears the Linear project when Paperclip projectId is removed", async () => {
    const ctx = createCtx();

    await sync.syncToLinear(
      ctx,
      issueLink(),
      { projectId: null },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-issue-1",
      { projectId: null },
    );
  });

  it("skips only the project move when the target Paperclip project is not linked", async () => {
    const ctx = createCtx();

    await sync.syncToLinear(
      ctx,
      issueLink(),
      { title: "Keep syncing other changes", projectId: "unlinked-project" },
      "lin-token",
      "team-1",
    );

    expect(updateIssue).toHaveBeenCalledWith(
      expect.any(Function),
      "lin-token",
      "lin-issue-1",
      { title: "Keep syncing other changes" },
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("is not linked to Linear"),
    );
  });
});
