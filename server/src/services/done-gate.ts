/**
 * Done-execution gate (narrated-completion hardening).
 *
 * Pure predicate: should a transition to `done` be blocked because there is no
 * evidence the agent actually executed the work?
 *
 * An agent run only produces real artifacts when it goes through an
 * issue-execution checkout, which sets `checkoutRunId`. Agents that merely
 * narrate "## Done" via the board API never reach checkout, so a `done`
 * transition with `checkoutRunId == null` and no pr-link evidence is a
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
 * ## Why the lock column is not enough (BLO-19081, BLO-20691)
 *
 * `issues.executionRunId` is a *dispatch lock*, not a record of work. Reading it
 * as completion evidence is wrong in BOTH directions, and the two defects were
 * found separately:
 *
 * **False negative (BLO-19081).** `issues.update()` nulls the lock columns
 * (`executionRunId` / `checkoutRunId` / `executionLockedAt` /
 * `executionAgentNameKey`) on ANY status change away from `in_progress` — see
 * the patch builder in `issues.ts`. So on the ordinary
 * `in_progress -> in_review -> done` path the columns are already `null` by the
 * time `done` is requested, even though a real run did the work. They only read
 * non-null when an issue goes straight `in_progress -> done` in a single patch.
 *
 * The consequence was a class of work that could not be closed by an agent at
 * all: investigations, config archaeology, premise audits, and operational
 * receipts, whose deliverable is a sourced finding rather than a commit. They
 * have no PR to cite and never will, and their lock is long since released.
 *
 * **False positive (BLO-20691).** The symmetric defect: `executionRunId` is set
 * by the *dispatcher*, before any agent has executed anything.
 * `heartbeat.ts` stamps it on a merely QUEUED run
 * (`executionRunId: queuedRun.id`, leaving `checkoutRunId` untouched), and the
 * process-loss retry path stamps it while explicitly nulling checkout
 * (`checkoutRunId: null, executionRunId: retryRun.id`). So the old
 * `existingExecutionRunId != null` short-circuit passed for any issue the
 * dispatcher had merely touched — a routine occurrence, and far weaker than the
 * self-certification protection this gate exists to provide. Observed on
 * BLO-20192: the same deliverable was rejected at 04:43 with no run, then
 * accepted at 04:45 solely because a queued run held the lock.
 *
 * The fix reads `checkoutRunId` instead. A real checkout
 * (`issues.ts` checkout path) sets `checkoutRunId` and `executionRunId`
 * together to the actor's run, so this is strictly narrower: it still admits
 * every genuine single-patch `in_progress -> done` close by the run that did
 * the work, and no longer admits a bare queued dispatch lock.
 *
 * A checked-out run that narrates without producing anything is a deliberately
 * accepted residual: BLO-19081's regression criterion requires the genuine
 * single-patch close to pass, and that close has no other evidence to offer by
 * construction. Proving a run *produced* something is what the durable-artifact
 * path below is for.
 *
 * The gate keeps its intent — an agent must not self-certify completion with
 * prose — and corrects the field it reads. A third evidence shape is
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
 * ## Ruling: off-issue deliverables (governance / board-comms) — BLO-20691
 *
 * Some work's deliverable lands somewhere other than the issue: a comment on a
 * board approval, a decision recorded against another object. BLO-20192 was one
 * (the deliverable was an approval comment), and no artifact shape reachable
 * from the issue could satisfy the gate.
 *
 * DECIDED: the gate gains no cross-object evidence shape, and this work stays
 * issue-closable. Chasing an arbitrary off-issue reference would mean trusting
 * a pointer to something the closing run may not have produced — every such
 * reference is a new way for a narrator to cite someone else's work — and the
 * gate's security property is precisely that evidence is durable,
 * run-attributed, AND reachable from the issue a reviewer is looking at.
 *
 * What agents do instead: write the RECEIPT to an issue document
 * (`PUT /api/issues/:id/documents/:key`) — what was decided, the approval or
 * object id, a link, and the resulting state — then close. That is one API
 * call, it produces a durable run-attributed artifact on the issue, and it
 * leaves the deliverable auditable from the place a reviewer actually looks.
 * The 422 message already directs agents here; this note records that the
 * direction is deliberate and covers off-issue deliverables too, rather than
 * being an oversight for them.
 *
 * Wired behind the instance flag `enableDoneExecutionGate` (default off).
 */

export interface DoneGateInput {
  /** The issue's current (pre-update) status. */
  fromStatus: string;
  /** The requested next status (undefined when the patch doesn't change status). */
  toStatus: string | undefined;
  /**
   * The issue's current (pre-update) `checkoutRunId`; non-null iff a run
   * actually reached issue-execution checkout.
   *
   * Deliberately NOT `executionRunId`: that column is a dispatch lock the
   * scheduler stamps on a merely queued run, so reading it here let any
   * dispatcher touch satisfy the gate (BLO-20691). The field is named for the
   * column it must read so a call site cannot pass the wrong one by habit.
   */
  existingCheckoutRunId: string | null;
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
  if (input.existingCheckoutRunId != null) return false;
  if (hasPrLinkEvidence(input.lastEvidenceVerdict)) return false;
  if (input.hasDurableArtifactEvidence) return false;
  return true;
}
