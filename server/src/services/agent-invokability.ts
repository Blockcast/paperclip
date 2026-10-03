import type { Db, DbTransaction } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { getAgentWorkEligibility, type AgentEligibilityAgent, type AgentOrgChainHealth } from "@paperclipai/shared";
import { eq } from "drizzle-orm";

type AgentStatus = (typeof agents.$inferSelect)["status"];

export type AgentOrgRow = Pick<
  typeof agents.$inferSelect,
  "id" | "companyId" | "name" | "reportsTo" | "status"
>;

export type AgentInvokabilityBlockReason =
  | "missing"
  | "paused"
  | "terminated"
  | "pending_approval"
  | "unknown_status"
  | "manager_missing"
  | "manager_company_mismatch"
  | "manager_terminated"
  | "reporting_cycle"
  | "reporting_chain_too_deep";

export type AgentInvokability =
  | { invokable: true }
  | {
      invokable: false;
      reason: AgentInvokabilityBlockReason;
      message: string;
      details: Record<string, unknown>;
      invalidOrgChain: boolean;
    };

export const DIRECT_NON_INVOKABLE_STATUSES = new Set<AgentStatus>([
  "paused",
  "terminated",
  "pending_approval",
]);

function blocked(
  reason: AgentInvokabilityBlockReason,
  message: string,
  details: Record<string, unknown>,
  invalidOrgChain = false,
): AgentInvokability {
  return { invokable: false, reason, message, details, invalidOrgChain };
}

function statusBlockReason(status: AgentStatus): AgentInvokabilityBlockReason | null {
  if (status === "paused") return "paused";
  if (status === "terminated") return "terminated";
  if (status === "pending_approval") return "pending_approval";
  return null;
}

function toEligibilityAgent(row: AgentOrgRow): AgentEligibilityAgent {
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    status: row.status,
    reportsTo: row.reportsTo,
  };
}

function invalidChainReason(health: AgentOrgChainHealth): AgentInvokabilityBlockReason {
  if (health.reason === "terminated_ancestor") return "manager_terminated";
  if (health.reason === "cycle") return "reporting_cycle";
  return "manager_missing";
}

export function evaluateAgentInvokability(
  agent: AgentOrgRow | null | undefined,
  // `readonly` so a memoised roster (one frozen array shared by every hit within the TTL)
  // can be passed without a defensive copy. This function only reads and `map`s, so the
  // narrowing costs nothing and every existing mutable-array caller still type-checks.
  companyAgents: readonly AgentOrgRow[],
): AgentInvokability {
  if (!agent) {
    return blocked("missing", "Agent no longer exists", {}, false);
  }

  const eligibility = getAgentWorkEligibility({
    agent: toEligibilityAgent(agent),
    agents: companyAgents.map(toEligibilityAgent),
  });

  if (eligibility.invokable) return { invokable: true };

  const directStatusReason = eligibility.invokabilityReason === "unknown_status"
    ? "unknown_status"
    : statusBlockReason(agent.status);
  if (directStatusReason) {
    return blocked(
      directStatusReason,
      "Agent is not invokable in its current state",
      { agentId: agent.id, agentStatus: agent.status },
      false,
    );
  }

  const health = eligibility.orgChainHealth;
  const firstInvalidAncestor = health.firstInvalidAncestor;
  return blocked(
    invalidChainReason(health),
    "Agent is not invokable because its reporting chain is invalid",
    {
      agentId: agent.id,
      managerId: firstInvalidAncestor?.id ?? null,
      managerStatus: firstInvalidAncestor?.status ?? null,
      reportingChainAgentIds: health.fullChain
        .filter((entry) => entry.relation === "ancestor")
        .map((entry) => entry.id),
      orgChainHealth: health,
    },
    true,
  );
}

/**
 * The company-roster read behind `evaluateAgentInvokabilityFromDb`.
 *
 * Exported so a caller that wants to *memoise* the read can reuse the exact query
 * rather than restate it (PEN-3636). The column list is the load-bearing part: it is
 * what `evaluateAgentInvokability` destructures, so a second copy that drifts from
 * this one produces an `AgentOrgRow` missing a field the pure evaluator reads. Lifting
 * it to one definition is the same correction Ally asked for on #2194's three-times
 * duplicated pause-hold predicate — the superset property should hold by construction,
 * not by two call sites being edited together.
 *
 * Deliberately NOT id-filtered: the org-chain walk needs every agent in the company,
 * which is exactly why this read is expensive enough to be worth memoising.
 */
export async function readCompanyAgentRoster(
  db: Pick<Db, "select">,
  companyId: string,
): Promise<AgentOrgRow[]> {
  return db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

/**
 * Serves `readCompanyAgentRoster` from a short-lived per-pass memo.
 *
 * Structurally identical to `ActivePauseHoldPrefilter` and implemented in
 * `recovery/agent-roster-memo.ts`; declared here as a bare shape so this module keeps
 * no dependency on the recovery sweep and no caching policy of its own.
 */
export type CompanyAgentRosterReader = {
  // `readonly` because a memo serves one array instance to every hit: see
  // `AgentRosterMemo.companyAgents`. Widening it here would let a consumer sort the
  // shared entry in place.
  companyAgents(companyId: string): Promise<readonly AgentOrgRow[]>;
};

export async function evaluateAgentInvokabilityFromDb(
  // Callers holding an advisory lock MUST pass their own transaction — a second
  // pool connection here is what convoyed on BLO-34207.
  db: Db | DbTransaction,
  agent: AgentOrgRow | null | undefined,
  // PEN-3636: optional, and omitting it preserves today's behaviour exactly — every
  // caller that does not pass one still takes a live roster read per call. A sweep
  // passes one so a run of candidates sharing a company reads the roster once.
  //
  // ⚠️ A reader supplied here reads on whatever handle it was built with, which this
  // function cannot check and the type cannot express. Supplying one whose handle
  // disagrees with `db` — a pool-bound memo passed alongside a transaction — yields a
  // roster blind to that transaction's uncommitted writes. Caller's obligation.
  rosterReader?: CompanyAgentRosterReader,
): Promise<AgentInvokability> {
  if (!agent) return evaluateAgentInvokability(agent, []);
  const companyAgents = rosterReader
    ? await rosterReader.companyAgents(agent.companyId)
    : await readCompanyAgentRoster(db, agent.companyId);
  return evaluateAgentInvokability(agent, companyAgents);
}

export function listInvalidOrgChainDescendantIds(
  terminatedAgentId: string,
  companyAgents: AgentOrgRow[],
): string[] {
  const byManager = new Map<string | null, AgentOrgRow[]>();
  for (const row of companyAgents) {
    const siblings = byManager.get(row.reportsTo ?? null) ?? [];
    siblings.push(row);
    byManager.set(row.reportsTo ?? null, siblings);
  }

  const invalidDescendantIds: string[] = [];
  const stack = [...(byManager.get(terminatedAgentId) ?? [])];
  const seen = new Set<string>([terminatedAgentId]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current.id)) continue;
    seen.add(current.id);
    if (current.status !== "terminated") {
      invalidDescendantIds.push(current.id);
    }
    stack.push(...(byManager.get(current.id) ?? []));
  }
  return invalidDescendantIds;
}

export function shouldCancelRunsForNonInvokableAgent(result: AgentInvokability) {
  return !result.invokable && (result.reason === "terminated" || result.invalidOrgChain);
}
