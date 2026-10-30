import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  agentWorkspaceClaimName,
  ensureAgentWorkspacePvc,
  AGENT_WORKSPACE_PVC_TYPE,
  DEFAULT_AGENT_WORKSPACE_CAPACITY,
  DEFAULT_AGENT_WORKSPACE_STORAGE_CLASS,
} from "./workspace-pvc.js";
import { getPvc, createPvc } from "./k8s-client.js";

vi.mock("./k8s-client.js", () => ({
  getPvc: vi.fn(),
  createPvc: vi.fn(),
}));

const AGENT_ID = "29033747-e513-46d5-8a13-dcb5dac10017";
const NAMESPACE = "paperclip";

beforeEach(() => {
  vi.resetAllMocks();
});

/** An @kubernetes/client-node `ApiException` as actually constructed: only `code` is set. */
function apiException(code: number): Error {
  const err = new Error(`HTTP-Code: ${code}`);
  (err as unknown as Record<string, unknown>).code = code;
  return err;
}

describe("agentWorkspaceClaimName", () => {
  it("derives a stable, DNS-1123 name from the agent id", () => {
    expect(agentWorkspaceClaimName(AGENT_ID)).toBe(`agent-workspace-${AGENT_ID}`);
  });

  it("is a valid DNS-1123 subdomain and within the 253-char limit", () => {
    const name = agentWorkspaceClaimName(AGENT_ID);
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(253);
  });

  it("sanitises rather than emitting a name the API server would reject", () => {
    expect(agentWorkspaceClaimName("AB_cd/ef!")).toBe("agent-workspace-abcdef");
  });

  it("refuses an id with no usable characters instead of returning a bare prefix", () => {
    // A bare `agent-workspace-` prefix would be the same name for every such
    // id, so two agents would silently share one claim.
    expect(() => agentWorkspaceClaimName("___")).toThrow(/no DNS-1123 characters/);
  });
});

describe("ensureAgentWorkspacePvc", () => {
  it("returns the existing claim without creating anything", async () => {
    vi.mocked(getPvc).mockResolvedValue({
      metadata: { name: "x" },
      spec: { accessModes: ["ReadWriteMany"] },
    });

    const name = await ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE });

    expect(name).toBe(`agent-workspace-${AGENT_ID}`);
    expect(createPvc).not.toHaveBeenCalled();
  });

  // The adopt path is where a wrong claim actually arrives: the create path is
  // pinned RWX by a test, but a claim made by an earlier revision or by hand
  // (following the RWO `opencode-db` precedent) is otherwise adopted forever
  // with nothing re-checking it.
  it("refuses to adopt a pre-existing claim that is not RWX", async () => {
    vi.mocked(getPvc).mockResolvedValue({
      metadata: { name: "x" },
      spec: { accessModes: ["ReadWriteOnce"] },
    });

    await expect(
      ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE }),
    ).rejects.toThrow(/not ReadWriteMany[\s\S]*immutable/);
    expect(createPvc).not.toHaveBeenCalled();
  });

  it("adopts a claim that lists RWX among several modes", async () => {
    vi.mocked(getPvc).mockResolvedValue({
      metadata: { name: "x" },
      spec: { accessModes: ["ReadWriteOnce", "ReadWriteMany"] },
    });

    await expect(
      ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE }),
    ).resolves.toBe(`agent-workspace-${AGENT_ID}`);
  });

  // Missing spec means the read told us nothing, not that the claim is wrong.
  // Refusing here would fail runs over a reporting gap.
  it("adopts when the read reports no access modes to judge", async () => {
    vi.mocked(getPvc).mockResolvedValue({ metadata: { name: "x" } });

    await expect(
      ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE }),
    ).resolves.toBe(`agent-workspace-${AGENT_ID}`);
  });

  it("creates an RWX claim with the agent-workspace labels and defaults", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({});

    await ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE });

    expect(createPvc).toHaveBeenCalledTimes(1);
    const [ns, body] = vi.mocked(createPvc).mock.calls[0];
    expect(ns).toBe(NAMESPACE);
    expect(body.metadata?.name).toBe(`agent-workspace-${AGENT_ID}`);
    expect(body.metadata?.labels?.["paperclip.io/agent-id"]).toBe(AGENT_ID);
    expect(body.metadata?.labels?.["paperclip.io/pvc-type"]).toBe(AGENT_WORKSPACE_PVC_TYPE);
    expect(body.spec?.storageClassName).toBe(DEFAULT_AGENT_WORKSPACE_STORAGE_CLASS);
    expect(body.spec?.resources?.requests?.storage).toBe(DEFAULT_AGENT_WORKSPACE_CAPACITY);
  });

  // The single most important assertion in this file. An agent's concurrent run
  // pods land on DIFFERENT nodes (measured: one agent across `-3` x2, `-7`,
  // `-11`), so an RWO claim would Multi-Attach and wedge every concurrent run.
  // The in-tree `opencode-db-<agentId>` precedent IS RWO, which is exactly why
  // this is pinned by a test rather than left to the next person to copy.
  it("requests ReadWriteMany, never ReadWriteOnce", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({});

    await ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE });

    const [, body] = vi.mocked(createPvc).mock.calls[0];
    expect(body.spec?.accessModes).toEqual(["ReadWriteMany"]);
  });

  it("honours an explicit storage class and capacity", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({});

    await ensureAgentWorkspacePvc({
      agentId: AGENT_ID,
      namespace: NAMESPACE,
      storageClass: "cephfs-fast",
      capacity: "10Gi",
    });

    const [, body] = vi.mocked(createPvc).mock.calls[0];
    expect(body.spec?.storageClassName).toBe("cephfs-fast");
    expect(body.spec?.resources?.requests?.storage).toBe("10Gi");
  });

  it("falls back to the defaults when the overrides are blank", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockResolvedValue({});

    await ensureAgentWorkspacePvc({
      agentId: AGENT_ID,
      namespace: NAMESPACE,
      storageClass: "   ",
      capacity: "",
    });

    const [, body] = vi.mocked(createPvc).mock.calls[0];
    expect(body.spec?.storageClassName).toBe(DEFAULT_AGENT_WORKSPACE_STORAGE_CLASS);
    expect(body.spec?.resources?.requests?.storage).toBe(DEFAULT_AGENT_WORKSPACE_CAPACITY);
  });

  // Two concurrent runs of the SAME agent can both read "absent" and both
  // create. The loser must not fail its run: the winner created exactly the
  // object this call wanted, under a name that encodes the agent id.
  it("treats a 409 from a concurrent creator as success", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockRejectedValue(apiException(409));

    await expect(
      ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE }),
    ).resolves.toBe(`agent-workspace-${AGENT_ID}`);
  });

  // The 409 tolerance must not become a blanket catch. A 403 means RBAC does
  // not permit the create, and returning a claim name nothing provisioned
  // would strand the Job on a volume that does not exist.
  it("propagates a non-409 create failure", async () => {
    vi.mocked(getPvc).mockResolvedValue(null);
    vi.mocked(createPvc).mockRejectedValue(apiException(403));

    await expect(
      ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE }),
    ).rejects.toThrow(/HTTP-Code: 403/);
  });

  it("propagates a read failure rather than creating over it", async () => {
    vi.mocked(getPvc).mockRejectedValue(apiException(500));

    await expect(
      ensureAgentWorkspacePvc({ agentId: AGENT_ID, namespace: NAMESPACE }),
    ).rejects.toThrow(/HTTP-Code: 500/);
    expect(createPvc).not.toHaveBeenCalled();
  });
});
