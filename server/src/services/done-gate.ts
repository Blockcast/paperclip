/**
 * Done-execution gate (narrated-completion hardening).
 *
 * Pure predicate: should a transition to `done` be blocked because there is no
 * evidence the agent actually executed the work?
 *
 * An agent run only produces real artifacts when it goes through an
 * issue-execution checkout, which sets `executionRunId`. Agents that merely
 * narrate "## Done" via the board API never acquire a run, so a `done`
 * transition with `executionRunId == null` and no pr-link evidence is a
 * narrated completion, not a real one.
 *
 * Guarded so it never blocks:
 *  - non-`done` transitions,
 *  - no-op `done` -> `done`,
 *  - human actors (only agent self-completions are gated),
 *  - issues whose last evidence verdict detected a `pr-link` anywhere in the
 *    recent evidence text (recorded by the in_review evidence gate when a
 *    real PR was attached) — independent of whether `pr-link` happens to be
 *    a *required* shape for this issue's labels.
 *
 * Wired behind the instance flag `enableDoneExecutionGate` (default off).
 */

export interface DoneGateInput {
  /** The issue's current (pre-update) status. */
  fromStatus: string;
  /** The requested next status (undefined when the patch doesn't change status). */
  toStatus: string | undefined;
  /** The issue's current (pre-update) executionRunId; non-null iff a real run was checked out. */
  existingExecutionRunId: string | null;
  /** The issue's stored lastEvidenceVerdict (jsonb); shape is validated defensively. */
  lastEvidenceVerdict: unknown;
  /** True when the transition is driven by an agent (not a human). */
  isAgentActor: boolean;
}

function hasPrLinkEvidence(verdict: unknown): boolean {
  if (!verdict || typeof verdict !== "object") return false;
  // `evidenceFound` on the stored verdict is `required ∩ detected` (see
  // evidence-gate.ts) — a real PR link pasted in a comment is invisible
  // there whenever the issue's label set doesn't require the `pr-link`
  // shape (e.g. unlabeled issues, or `infra`/`backend`-labeled issues,
  // which is most non-frontend work). `allDetected` is the unfiltered set
  // of every shape the evaluator actually found, independent of what this
  // issue's labels require, so it's the correct source for "was a real PR
  // ever attached" (BLO-16325: agents pasted valid GitHub PR/commit URLs
  // and still got `no_execution_run_and_no_pr_evidence`). Keep the
  // `evidenceFound` check too for defensiveness against older/malformed
  // stored verdicts that predate `allDetected`.
  const { allDetected, evidenceFound } = verdict as {
    allDetected?: unknown;
    evidenceFound?: unknown;
  };
  if (Array.isArray(allDetected) && allDetected.includes("pr-link")) return true;
  if (Array.isArray(evidenceFound) && evidenceFound.includes("pr-link")) return true;
  return false;
}

export function shouldBlockNarratedDone(input: DoneGateInput): boolean {
  if (input.toStatus !== "done") return false;
  if (input.fromStatus === "done") return false;
  if (!input.isAgentActor) return false;
  if (input.existingExecutionRunId != null) return false;
  if (hasPrLinkEvidence(input.lastEvidenceVerdict)) return false;
  return true;
}
