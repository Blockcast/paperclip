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
 *    a *required* shape for this issue's labels,
 *  - issues carrying run-attributed DURABLE ARTIFACT evidence (see below).
 *
 * ## Why `existingExecutionRunId` alone is not enough (BLO-19081)
 *
 * `issues.executionRunId` is a *lock*, not a record. `issues.update()` nulls
 * it (with `checkoutRunId` / `executionLockedAt` / `executionAgentNameKey`) on
 * ANY status change away from `in_progress` — see the patch builder in
 * `issues.ts`. So on the ordinary `in_progress -> in_review -> done` path the
 * column is already `null` by the time `done` is requested, even though a real
 * run did the work. The check only reads non-null when an issue goes straight
 * `in_progress -> done` in a single patch.
 *
 * The consequence is a class of work that could not be closed by an agent at
 * all: investigations, config archaeology, premise audits, and operational
 * receipts, whose deliverable is a sourced finding rather than a commit. They
 * have no PR to cite and never will, and their lock is long since released.
 *
 * The fix keeps the gate's intent — an agent must not self-certify completion
 * with prose — and corrects the field it reads. A third evidence shape is
 * accepted: a durable, inspectable artifact attached to the issue (an issue
 * document, or an `artifact`/`document` work product), which is
 * *server-attributed to a real run*. Two properties make this strictly a fix
 * rather than a deletion of the gate:
 *
 *  1. It is not satisfiable from the comment thread. A comment body — however
 *     long or well-sourced — never produces one of these rows, so
 *     comment-only prose still fails the gate. That is the invariant under
 *     test in `done-gate.test.ts`; if it ever passes, the gate is gone.
 *  2. It is run-attributed. The qualifying row's `createdByRunId` is stamped
 *     by the server from the authenticated actor's run context, never from a
 *     client-supplied field, so the runless board-API narrator this gate was
 *     built to stop still cannot produce one.
 *
 * Computing the flag is the caller's job (it needs DB access); this module
 * stays a pure predicate. Callers MUST compute it lazily — only once the
 * cheaper checks have already decided to block — so the ordinary update path
 * pays no extra query.
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
  /**
   * True when the issue carries a run-attributed durable artifact — an issue
   * document, or an `artifact`/`document` work product — that a reviewer can
   * open and inspect. Comment bodies never set this. Required (not optional)
   * so a caller cannot omit it and silently widen the gate; pass `false` when
   * you have not looked.
   */
  hasDurableArtifactEvidence: boolean;
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
  if (input.hasDurableArtifactEvidence) return false;
  return true;
}
