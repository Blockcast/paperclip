import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agents, environments } from "@paperclipai/db";
import {
  AGENT_WORKSPACE_CLAIM_PREFIX,
  listReclaimableClaims,
  type ReclaimableClaim,
} from "../services/isolation-workspace-reaper.js";

/**
 * `listReclaimableClaims` turns the coverage GAUGE into the sweep's INPUT.
 *
 * Two things are pinned here and they fail in different ways.
 *
 * The behavioural half is ordinary: which rows become claims, which are
 * excluded, and how duplicates collapse.
 *
 * The agreement half guards a duplication that cannot be removed. The server
 * does not import vendor code at runtime, so the per-agent claim name is
 * derived twice — once by the adapter that CREATES the claim and mounts it,
 * once here by the sweep that must find it. A drift between them does not
 * throw: it names a PVC that does not exist, the reclaim Job sits `Pending`
 * on an unbound claim, and the sweep reports that it launched while the tree
 * it was launched for keeps growing. So the adapter's own source is read as
 * the third party both sides are held to, on the
 * `orphan-artifact-path-agreement.test.ts` precedent.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const adapterPvcSource = readFileSync(
  path.join(repoRoot, "vendor/paperclip-adapter-claude-k8s/src/server/workspace-pvc.ts"),
  "utf-8",
);
const reaperSource = readFileSync(
  path.join(repoRoot, "server/src/services/isolation-workspace-reaper.ts"),
  "utf-8",
);

/** Rows the fake `db` hands back, keyed by which table the query selected from. */
interface FakeRows {
  agents?: Array<{ id: string; config: unknown }>;
  environments?: Array<{ config: unknown }>;
}

/**
 * Minimal `db` double.
 *
 * Dispatches on the table object rather than on call order, so a future change
 * that reorders the two queries does not silently feed agent rows to the
 * environment arm and pass anyway.
 */
function fakeDb(rows: FakeRows) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === environments ? (rows.environments ?? []) : (rows.agents ?? [])),
      }),
    }),
  };
}

function listed(rows: FakeRows, self: string | null = null): Promise<ReclaimableClaim[]> {
  return listReclaimableClaims(fakeDb(rows) as never, self);
}

const AGENT_A = "29033747-e513-46d5-8a13-dcb5dac10017";
const AGENT_B = "7500672d-efe6-4037-a05f-61204a670894";

describe("listReclaimableClaims (PEN-5151)", () => {
  it("derives a claim for an opted-in agent", async () => {
    expect(await listed({ agents: [{ id: AGENT_A, config: { enablePerAgentWorkspaceVolume: true } }] })).toEqual([
      { claimName: `agent-workspace-${AGENT_A}`, source: "agent_per_agent_volume", agentId: AGENT_A },
    ]);
  });

  it("takes an explicit workspaceVolumeClaim over the derived name", async () => {
    // The adapter reads `workspaceVolumeClaim` as an override, so an agent
    // carrying both is on the NAMED volume. Returning the derived name here
    // would send the sweep to a claim nothing mounts.
    const claims = await listed({
      agents: [
        {
          id: AGENT_A,
          config: { enablePerAgentWorkspaceVolume: true, workspaceVolumeClaim: "operator-chosen" },
        },
      ],
    });
    expect(claims).toEqual([
      { claimName: "operator-chosen", source: "agent_workspace_claim", agentId: AGENT_A },
    ]);
  });

  it("only a JSON boolean true opts an agent in", async () => {
    // Mirrors `asBoolean`: the STRING "true" is not an opt-in, and its Job
    // does mount the shared claim. Enumerating it would launch a Job against
    // a claim that was never provisioned.
    expect(await listed({ agents: [{ id: AGENT_A, config: { enablePerAgentWorkspaceVolume: "true" } }] })).toEqual(
      [],
    );
  });

  it("enumerates a k8s environment's claim, unattributed", async () => {
    // The gauge can only answer UNKNOWN here because it cannot say which
    // agents land on this environment. The claim NAME is still a literal, and
    // the claim is what the sweep mounts.
    expect(await listed({ environments: [{ config: { workspaceVolumeClaim: "env-claim" } }] })).toEqual([
      { claimName: "env-claim", source: "environment_claim", agentId: null },
    ]);
  });

  it("excludes the server's own claim from both arms", async () => {
    // Failing open here would launch a deletion Job against the volume the
    // mounted sweep is already walking.
    const claims = await listed(
      {
        agents: [{ id: AGENT_A, config: { workspaceVolumeClaim: "paperclip-data" } }],
        environments: [{ config: { workspaceVolumeClaim: "  paperclip-data  " } }],
      },
      "paperclip-data",
    );
    expect(claims).toEqual([]);
  });

  it("collapses duplicates and keeps the more specific attribution", async () => {
    // One claim named by an agent AND by an environment must yield ONE Job:
    // two executors unlinking one ReadWriteMany tree from plans built at
    // different instants is the concurrent-sibling case the design refused.
    const claims = await listed({
      agents: [
        { id: AGENT_A, config: { workspaceVolumeClaim: "shared-claim" } },
        { id: AGENT_B, config: { workspaceVolumeClaim: "shared-claim" } },
      ],
      environments: [{ config: { workspaceVolumeClaim: "shared-claim" } }],
    });
    expect(claims).toEqual([
      { claimName: "shared-claim", source: "agent_workspace_claim", agentId: AGENT_A },
    ]);
  });

  it("skips an unslugabble agent id without taking the sweep down", async () => {
    // The adapter THROWS on this id, and should: there, refusing is what stops
    // an opted-in Job mounting the shared claim. Here the equivalent mistake
    // is sweeping the wrong volume, so the row is dropped -- and the other
    // agent's claim still has to come back.
    const claims = await listed({
      agents: [
        { id: "...", config: { enablePerAgentWorkspaceVolume: true } },
        { id: AGENT_B, config: { enablePerAgentWorkspaceVolume: true } },
      ],
    });
    expect(claims).toEqual([
      { claimName: `agent-workspace-${AGENT_B}`, source: "agent_per_agent_volume", agentId: AGENT_B },
    ]);
  });
});

describe("claim-name agreement with the adapter (PEN-5151)", () => {
  it("uses the prefix the adapter builds claims with", () => {
    // Read from the adapter's source, not from our own constant: comparing a
    // value with itself passes for any value.
    const match = adapterPvcSource.match(/return `([a-z0-9-]+-)\$\{slug\}`;/);
    expect(match, "adapter's agentWorkspaceClaimName no longer returns a `<prefix>${slug}` template")
      .not.toBeNull();
    expect(AGENT_WORKSPACE_CLAIM_PREFIX).toBe(match?.[1]);
  });

  it("slugs an agent id through the same pipeline the adapter does", () => {
    // Both sides are read from disk; neither is derived from the other, so a
    // change to either one fails this.
    const steps = /\.toLowerCase\(\)\s*\.replace\(\/\[\^a-z0-9-\]\/g, ""\)\s*\.replace\(\/\^-\+\|-\+\$\/g, ""\)\s*\.slice\(0, (\d+)\)/;
    const adapterSteps = adapterPvcSource.match(steps);
    const reaperSteps = reaperSource.match(steps);
    expect(adapterSteps, "adapter's slug pipeline changed shape").not.toBeNull();
    expect(reaperSteps, "reaper's slug pipeline changed shape").not.toBeNull();
    expect(reaperSteps?.[1]).toBe(adapterSteps?.[1]);
  });
});
