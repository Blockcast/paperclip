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

/**
 * PEN-5511: `linkCoverageForIssue` is the completeness report for an issue-scoped
 * approval query. The query it reports on reads through `issue_approvals`, so it
 * returns LINKED cards only; before PEN-5511 a card filed by a non-assignee could
 * not be linked to the row it was about at all, which made that count silently
 * partial in the direction that understates board exposure.
 *
 * The contract worth pinning is not the SQL but the three verdicts it can reach,
 * because they are three different answers and only two of them are measurements:
 * candidates found, none found, and "not measurable on this row".
 */
function dbForLinkCoverage(linkedCount: number, candidateCount: number) {
  const counts = [[{ count: linkedCount }], [{ count: candidateCount }]];
  let call = 0;
  return {
    select: vi.fn(() => {
      const rows = counts[call++] ?? [];
      const terminal = async () => rows;
      return {
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({ where: terminal })),
          where: terminal,
        })),
      };
    }),
  };
}

describe("issueApprovalService.linkCoverageForIssue (PEN-5511)", () => {
  it("flags an issue whose identifier is named by undecided cards that are not linked to it", async () => {
    const svc = issueApprovalService(dbForLinkCoverage(3, 1) as never);

    const coverage = await svc.linkCoverageForIssue("company-1", {
      id: "issue-1",
      identifier: "PEN-5379",
    });

    // The measured PEN-5379 shape: three linked, a fourth standing ask unlinked.
    expect(coverage).toEqual({
      linkedCount: 3,
      unlinkedMentionCandidateCount: 1,
      potentiallyUnlinkedCards: true,
      basis: "undecided_payload_identifier_mention",
    });
  });

  it("reports false, with the basis that was actually measured, when no candidate is found", async () => {
    const svc = issueApprovalService(dbForLinkCoverage(2, 0) as never);

    const coverage = await svc.linkCoverageForIssue("company-1", {
      id: "issue-1",
      identifier: "PEN-5379",
    });

    expect(coverage.potentiallyUnlinkedCards).toBe(false);
    expect(coverage.unlinkedMentionCandidateCount).toBe(0);
    // `basis` is what keeps `false` honest: it is a lower bound from one specific
    // probe, not a proof of completeness, and the caller is told which probe ran.
    expect(coverage.basis).toBe("undecided_payload_identifier_mention");
  });

  it("answers NULL, not false, when the row has no identifier to match on", async () => {
    // The distinction this test exists for: "no candidates found" and "no search was
    // possible" are different answers, and only the first is evidence. Collapsing
    // the second to `false` would report completeness it never established — the
    // exact failure shape PEN-5511 was filed about.
    const svc = issueApprovalService(dbForLinkCoverage(1, 99) as never);

    const coverage = await svc.linkCoverageForIssue("company-1", {
      id: "issue-1",
      identifier: null,
    });

    expect(coverage.potentiallyUnlinkedCards).toBeNull();
    expect(coverage.unlinkedMentionCandidateCount).toBeNull();
    expect(coverage.basis).toBe("identifier_unavailable");
    expect(coverage.linkedCount).toBe(1);
  });
});
