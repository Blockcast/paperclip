import { describe, expect, it } from "vitest";
import {
  evaluateAgentInvokability,
  listInvalidOrgChainDescendantIds,
  type AgentOrgRow,
} from "../services/agent-invokability.ts";

function agent(partial: Partial<AgentOrgRow> & Pick<AgentOrgRow, "id">): AgentOrgRow {
  return {
    companyId: "company-1",
    name: partial.id,
    reportsTo: null,
    status: "active",
    ...partial,
  };
}

describe("agent invokability", () => {
  it("blocks active descendants under a terminated manager as invalid-org-chain", () => {
    const rows = [
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
    ];

    const result = evaluateAgentInvokability(rows[2], rows);

    expect(result).toMatchObject({
      invokable: false,
      reason: "manager_terminated",
      invalidOrgChain: true,
      details: {
        managerId: "ceo",
        reportingChainAgentIds: ["cto", "ceo"],
      },
    });
  });

  it("reports missing managers and cycles as invalid-org-chain", () => {
    const missingManager = [agent({ id: "coder", reportsTo: "missing" })];
    expect(evaluateAgentInvokability(missingManager[0], missingManager)).toMatchObject({
      invokable: false,
      reason: "manager_missing",
      invalidOrgChain: true,
    });

    const cycle = [
      agent({ id: "a", reportsTo: "b" }),
      agent({ id: "b", reportsTo: "a" }),
    ];
    expect(evaluateAgentInvokability(cycle[0], cycle)).toMatchObject({
      invokable: false,
      reason: "reporting_cycle",
      invalidOrgChain: true,
    });
  });

  it("keeps direct pause distinct from a broken reporting chain", () => {
    const paused = agent({ id: "paused", status: "paused" });
    expect(evaluateAgentInvokability(paused, [paused])).toMatchObject({
      invokable: false,
      reason: "paused",
      invalidOrgChain: false,
    });

    const pausedUnderMissingManager = agent({
      id: "paused-child",
      status: "paused",
      reportsTo: "missing",
    });
    expect(evaluateAgentInvokability(pausedUnderMissingManager, [pausedUnderMissingManager])).toMatchObject({
      invokable: false,
      reason: "paused",
      invalidOrgChain: false,
    });
  });

  it("lists non-terminated descendants made invalid by a terminated root", () => {
    const rows = [
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
      agent({ id: "old-coder", reportsTo: "cto", status: "terminated" }),
      agent({ id: "other-root" }),
    ];

    expect(listInvalidOrgChainDescendantIds("ceo", rows).sort()).toEqual(["coder", "cto"]);
  });

  // PEN-3636: pins the no-mutation property that makes the `readonly` narrowing sound.
  // The sweep's memo `Object.freeze`s each entry and hands the SAME instance to every hit,
  // so this consumer must never write to its input. `evaluateAgentInvokability` was
  // narrowed with the memo; this one was not, and a caller holding a frozen roster got a
  // compile error from a function that never mutates.
  //
  // ⚠️ What gates this, stated precisely because the obvious answer is wrong: **test files
  // in this package are NOT typechecked.** `server/tsconfig.json` excludes `src/__tests__`,
  // and `tsconfig.typecheck.json` exists only so `check-test-undefined-symbols.mjs` can see
  // them — it gates the undefined-identifier class alone and explicitly not tsc's exit code
  // (~740 pre-existing fixture errors). So reverting the parameter to `AgentOrgRow[]` would
  // NOT be caught by `Typecheck`, and an assertion written to pin the *type* would be
  // vacuous here.
  //
  // What this test does gate is the RUNTIME half, and it is genuinely falsifiable: add an
  // in-place `companyAgents.sort(...)` to the function and this goes red with a `TypeError`
  // on the frozen array (verified by mutation, 2026-10-03), while the mutable-input test
  // above stays green. That is the half that actually protects the memo's shared entry.
  it("does not mutate its input — a frozen roster is the shape a per-sweep memo hands out", () => {
    const frozenRows: readonly AgentOrgRow[] = Object.freeze([
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
      agent({ id: "old-coder", reportsTo: "cto", status: "terminated" }),
      agent({ id: "other-root" }),
    ]);

    expect(Object.isFrozen(frozenRows)).toBe(true);
    // Same answer as the mutable case above, so the narrowing changed the type and
    // nothing else.
    expect(listInvalidOrgChainDescendantIds("ceo", frozenRows).sort()).toEqual(["coder", "cto"]);
  });
});
