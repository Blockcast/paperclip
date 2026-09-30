import { describe, expect, it, vi } from "vitest";
import { issueApprovalService } from "../services/issue-approvals.js";

function dbForLinkedApprovals(approvals: Array<Record<string, unknown>>) {
  return {
    select: vi.fn()
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            then: async (resolve: (rows: unknown[]) => unknown) =>
              resolve([{ id: "issue-1", companyId: "company-1" }]),
          })),
        })),
      })
      .mockReturnValueOnce({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn(async () => approvals),
            })),
          })),
        })),
      }),
  };
}

describe("issueApprovalService", () => {
  it("does not structurally redact non-hire approval payloads linked to issues", async () => {
    const payload = {
      title: "Approve deploy target",
      env: { target: "production" },
      colorChoice: { type: "plain", value: "blue" },
    };

    const result = await issueApprovalService(dbForLinkedApprovals([{
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      payload,
      status: "pending",
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-30T00:00:00.000Z"),
    }]) as any).listApprovalsForIssue("issue-1");

    expect(result[0]?.payload).toEqual(payload);
  });

  it("structurally redacts hire approval payloads linked to issues", async () => {
    // `includeAgentConfig` is the caller's `agent_config:read` verdict (PEN-2777);
    // this case is about the credential redaction underneath it, so it asserts
    // the granted branch.
    const result = await issueApprovalService(dbForLinkedApprovals([{
      id: "approval-2",
      companyId: "company-1",
      type: "hire_agent",
      payload: {
        name: "Worker",
        adapterConfig: {
          env: {
            FOO: { legacyValue: "plaintext" },
            TOKEN: { type: "plain", value: "secret" },
          },
        },
      },
      status: "pending",
      createdAt: new Date("2026-07-30T00:00:00.000Z"),
      updatedAt: new Date("2026-07-30T00:00:00.000Z"),
    }]) as any).listApprovalsForIssue("issue-1", { includeAgentConfig: true });

    expect(result[0]?.payload).toEqual({
      name: "Worker",
      adapterConfig: {
        env: {
          FOO: "***REDACTED***",
          TOKEN: { type: "plain", value: "***REDACTED***" },
        },
      },
    });
  });

  it("withholds hire agent config by default, so a caller that never resolved the grant discloses no topology", async () => {
    const result = await issueApprovalService(dbForLinkedApprovals([{
      id: "approval-3",
      companyId: "company-1",
      type: "hire_agent",
      payload: {
        name: "Worker",
        adapterConfig: {
          mcpServers: { k8s: { url: "https://svc@k8s-mcp-admin.internal:8443/mcp" } },
        },
        requestedConfigurationSnapshot: {
          adapterType: "claude_k8s",
          adapterConfig: {
            mcpServers: { k8s: { url: "https://svc@k8s-mcp-admin.internal:8443/mcp" } },
          },
        },
      },
      status: "pending",
      createdAt: new Date("2026-08-31T00:00:00.000Z"),
      updatedAt: new Date("2026-08-31T00:00:00.000Z"),
    }]) as any).listApprovalsForIssue("issue-1");

    expect(JSON.stringify(result[0]?.payload)).not.toContain("k8s-mcp-admin.internal");
    expect(result[0]?.payload).toEqual({
      name: "Worker",
      adapterConfig: {},
      requestedConfigurationSnapshot: { adapterType: "claude_k8s", adapterConfig: {} },
    });
    expect(result[0]?.withheldFields).toEqual([
      "adapterConfig",
      "requestedConfigurationSnapshot.adapterConfig",
    ]);
  });
});
