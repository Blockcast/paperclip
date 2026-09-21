export const RECOVERY_MODEL_PROFILE_KEY = "cheap" as const;

export type RecoveryModelProfileWorkClass = "status_only" | "planning_only" | "normal_model";

// BLO-32634: the declared run class of a wake, stamped for ALL THREE classes —
// including `normal_model`, which writes no other key.
//
// The guard tuple is otherwise indistinguishable from silence at the merge:
// `withRecoveryModelProfileHint(x, "normal_model")` only DELETES keys, so a wake
// that had deliberately declared itself normal-model looked exactly like a wake
// that had never considered the question. `mergeCoalescedContextSnapshot` could
// not tell them apart and inherited the guard into both. This key is what makes
// "I am normal-model" a positive statement the merge can act on; its ABSENCE
// still means "silent about run class", which must keep inheriting.
export const RECOVERY_WORK_CLASS_KEY = "recoveryWorkClass" as const;

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

export const PLANNING_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "planning_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: true,
  resumeRequiresNormalModel: false,
} as const;

// Builds the guidance attached to every 403 whose `details` carry `resumeRequiresNormalModel: true`.
//
// That flag states a real *requirement* — the refused work does need a normal-model run — but on its
// own it reads as a *promise* that such a run will come around, and callers wait for it. They wait
// forever. The cheap profile is bound to the WAKE CLASS, not to any issue field: an issue holding an
// `activeRecoveryAction` is woken with `wakePolicy.reason: source_scoped_recovery_action`, and that
// class dispatches status-only runs by construction. Since only a recorded disposition clears the
// recovery action, "wait for a normal-model run on this issue" is unreachable by construction.
//
// BLO-25878 measured the cost: three consecutive runs on the BLO-8207 credential chain each
// assembled a complete board-ordered approval payload, each was refused, and each read this flag as
// a retry that would arrive. None did. State the reachable exits instead of implying an unreachable
// one — the caller can always take one of them in the run that is refused.
//
// BLO-32634: this string is scoped to the wakes the RECOVERY ACTION raises, not to "every wake on
// this issue". Since a wake that declares its own run class now owns the guard block at
// `mergeCoalescedContextSnapshot`, a declared normal-model wake on an issue with a live recovery
// action is reachable, and the older universal phrasing asserted an invariant the merge falsifies.
// The caller-facing point is unchanged and still exactly true: nothing you can WAIT for turns into
// a normal-model run, because only a recorded disposition clears the action. The narrower phrasing
// is deliberate in both directions — it must not go stale again, and it must not read to a refused
// agent as an instruction to go arm itself an unguarded run (that residual is BLO-32774).
//
// PEN-3275: the escalation exit is CONDITIONAL, so this is a function of the snapshot rather than a
// constant. `approvals.ts` refuses the `request_board_approval` create outright when the run context
// carries no source issue ("This status-only run cannot file a board escalation: its run context has
// no source issue"), and that state is ordinary rather than exotic: the `stale_active_run_evaluation`
// producers in `recovery/service.ts` stamp `sourceIssueId: sourceIssue?.id ?? null`, and
// `resolveStaleRunSourceIssue` returns `null` whenever the silent run's own snapshot carries no issue
// id — an unscoped heartbeat is exactly that — or the issue is not visible. So the detector that
// fires on a silent ISSUELESS run dispatched a status-only wake whose guidance named an escalation
// that run cannot file.
//
// That is the BLO-25878 shape one step in, and in the more dangerous direction: not a promise that a
// normal-model run is coming, but a promise that a FILING is available. The agent assembles the
// payload and gets a 403 — from text whose whole purpose is to stop it planning around an absent
// capability, and whose refusal list is otherwise exhaustive enough to license trusting the
// permissions too.
//
// Derived from `statusOnlyEscalationSourceIssueId`, which is the same function `approvals.ts` gates
// on. Sharing the predicate rather than restating the condition is what keeps the two honest: the
// guidance names the escalation exactly when the guard would admit it.
//
// PEN-3275 round 4: the escalation's link set is EXCLUSIVE, and saying only "linked to the source
// issue" is satisfied by a payload that also links the wider chain — which is the natural shape for
// a board escalation about a blocked issue, and which `approvals.ts` refuses ("A status-only run may
// only link a board escalation to its source issue"). On the run's single permitted write, the cost
// of that omission is the whole exit rather than a retry, so the exclusivity is stated here.
export function statusOnlyRecoveryResumeGuidance(contextSnapshot: unknown): {
  normalModelResumeIsAutomatic: false;
  resumeGuidance: string;
} {
  const preamble =
    "No normal-model run is dispatched for this issue on its own: every wake the recovery action " +
    "itself raises is status-only, and only a recorded disposition clears that action — so waiting " +
    "for a normal-model run never ends. ";
  return {
    normalModelResumeIsAutomatic: false,
    resumeGuidance: preamble + (statusOnlyEscalationSourceIssueId(contextSnapshot)
      ? "Reachable exits from this run: record a valid issue disposition to clear the recovery " +
        "action, or file a `request_board_approval` linked to the run context's source issue and " +
        "to no other issue."
      : "This run context carries no source issue, so it cannot file a `request_board_approval` " +
        "either. The only reachable exit from this run is recording a valid issue disposition to " +
        "clear the recovery action."),
  };
}

// The source issue a status-only run may link a board escalation to, or `null` if it has none.
//
// PEN-3275: hoisted out of `approvals.ts` so the ANNOUNCEMENT and the GUARD read one function. The
// guard tuple deliberately does not include this key — `isStatusOnlyRecoveryContextSnapshot` tests
// `modelProfile` plus the four `STATUS_ONLY_RECOVERY_GUARD_CONTEXT` keys and nothing else, so a
// snapshot with `sourceIssueId: null` is still fully status-only and still contained. Escalation
// availability is a SEPARATE question from containment, and the two must not be merged: adding this
// key to the tuple would make an issueless run read as unconstrained, which fails OPEN.
export function statusOnlyEscalationSourceIssueId(contextSnapshot: unknown): string | null {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const sourceIssueId = (contextSnapshot as Record<string, unknown>).sourceIssueId;
  return typeof sourceIssueId === "string" && sourceIssueId.trim() ? sourceIssueId : null;
}

// Does a run's `contextSnapshot` carry the full status-only guard tuple?
//
// BLO-32774: `issues.ts` used to hand-repeat these five keys inline. Deriving
// the predicate from `STATUS_ONLY_RECOVERY_GUARD_CONTEXT` instead means editing
// the tuple cannot leave a guard silently testing the old shape — that drift
// fails OPEN, which is the dangerous direction for a write-containment guard.
//
// Every key must match. A partial tuple is deliberately NOT status-only: the
// guard is the conjunction, and treating a subset as equivalent would let a
// caller clear one key to escape containment.
export function isStatusOnlyRecoveryContextSnapshot(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  if (context.modelProfile !== RECOVERY_MODEL_PROFILE_KEY) return false;
  return Object.entries(STATUS_ONLY_RECOVERY_GUARD_CONTEXT).every(([key, value]) => context[key] === value);
}

// The planning-only counterpart, derived from its own tuple for the same reason.
//
// PEN-3275: this predicate was hand-repeated in `approvals.ts` and `issues.ts` — the exact shape
// BLO-32774 removed from the status-only guard, and left in place here only because nothing had
// needed a SHARED planning-only read yet. `modelProfile` is deliberately not tested: the
// `planning_only` arm of `withRecoveryModelProfileHint` scrubs it rather than setting it, so
// requiring a value would make the predicate unsatisfiable, and the BLO-32634 residual means a
// coalesced escalation can legitimately retain `modelProfile: "cheap"` while being planning-capable.
export function isPlanningOnlyRecoveryContextSnapshot(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return Object.entries(PLANNING_ONLY_RECOVERY_GUARD_CONTEXT).every(([key, value]) => context[key] === value);
}

export type RecoveryRunWriteClass = Extract<RecoveryModelProfileWorkClass, "status_only" | "planning_only">;

declare const recoveryRunWriteClassNoticeBrand: unique symbol;

/**
 * The rendered write-containment notice, branded.
 *
 * PEN-3275 round 4: `buildPaperclipTaskMarkdown` frames this text as "System-generated, not
 * user-authored task data.", and it takes it pre-rendered because the status-only wording is
 * conditional on the snapshot — so the caller, not the frame, chooses the text. That is the right
 * split, but it left the authority claim asserted by POSITION: any string in that argument would
 * have been framed as system-authored. The brand moves the claim into the type, at no runtime
 * cost — `recoveryRunWriteClassNotice` is the only thing that can mint one.
 */
export type RecoveryRunWriteClassNoticeText = string & {
  readonly [recoveryRunWriteClassNoticeBrand]: true;
};

/**
 * Which write-containment class is this run executing under, if any?
 *
 * Returns `null` for an ordinary run — including a wake that positively declared itself
 * `normal_model`, which carries no guard tuple by design. Callers must treat `null` as
 * "unconstrained", never as "unknown".
 *
 * Reads the guard tuple rather than `RECOVERY_WORK_CLASS_KEY`. The tuple is what the route guards
 * in `approvals.ts` and `issues.ts` actually enforce against, so deriving the ANNOUNCEMENT from the
 * same input is what keeps the two honest: a run told it is status-only is exactly a run those
 * guards will refuse. `recoveryWorkClass` is the declaration and can be absent on an older or
 * coalesced snapshot, so announcing from it would go quiet precisely where the guards still bite.
 *
 * Status-only is tested first because it is the narrower tuple; the two are mutually exclusive
 * (`recoveryIntent` cannot hold both values), so the order is for readability, not correctness.
 */
export function readRecoveryRunWriteClass(contextSnapshot: unknown): RecoveryRunWriteClass | null {
  if (isStatusOnlyRecoveryContextSnapshot(contextSnapshot)) return "status_only";
  if (isPlanningOnlyRecoveryContextSnapshot(contextSnapshot)) return "planning_only";
  return null;
}

/**
 * PEN-3275. The agent-facing announcement of a run's write-containment class, for the wake prompt.
 *
 * Until now the class was stated ONLY in the body of a 403, which is to say: after the agent had
 * already planned around a capability it does not have. Reads are unaffected and most writes
 * succeed, so there is no earlier signal — the mode is discovered mid-task, on a refusal.
 *
 * Measured cost of that silence (PEN-3248, 2026-09-15): an agent composed a long comment stating
 * "I have commented on card X", the approval-comment write 403'd as the comment was being posted,
 * and the claim shipped. It needed a retraction; absent one it would have stood as a durable
 * non-event a peer could have relied on. Two agents hit the same refusal on the same row. The
 * defect is not the restriction — that is a deliberate cost and write-containment control — it is
 * that the restriction was unannounced until it fired.
 *
 * Two things this text must NOT do, both load-bearing:
 *
 *  - It must not read as an instruction to go acquire an unguarded normal-model run. That residual
 *    is BLO-32774, and `issues.ts` closed the concrete version of it (a guarded run arming itself a
 *    monitor). The exits named here are exactly the ones `statusOnlyRecoveryResumeGuidance`
 *    names — that function's output is appended verbatim rather than re-worded, so the wake and the
 *    403 cannot drift apart and a second phrasing cannot go stale on its own. Since PEN-3275 that
 *    also means the two agree on whether the escalation exit EXISTS, not merely on its wording.
 *  - It must not promise a normal-model run is coming. That was the BLO-25878 failure: three runs
 *    read `resumeRequiresNormalModel: true` as a retry that would arrive, and none did.
 *
 * The refusal lists name OPERATIONS, not objects, because the guards key on the operation and the
 * object-shaped phrasing predicted the wrong thing. `assertApprovalMutationAllowedByRunContext`
 * admits only the CREATE route: `approvals.ts` passes `requestedType` at the create call site and
 * nowhere else, so the comment, resubmit and withdraw routes all compare
 * `undefined !== BOARD_ESCALATION_APPROVAL_TYPE` and refuse — on the run's own escalation included.
 * An earlier draft read "creating or modifying approvals (except a single `request_board_approval`
 * …)", which invites exactly the PEN-3248 write: comment on the card you just filed.
 *
 * Enumerated against the five guards that consume these predicates, not from memory:
 * `assertApprovalMutationAllowedByRunContext` (`approvals.ts`), and in `issues.ts`
 * `assertApprovalMutationAllowedByRunContext` (link/unlink),
 * `assertDeliverableMutationAllowedByRunContext` (documents, deliverables, annotations),
 * `assertMonitorArmingAllowedByRunContext` and `assertCheapRecoveryIssueAssigneeProfileAllowed`.
 * The last two do not consult the planning-only predicate, which is why `planning_only` names
 * neither. If you add a guard that consumes them, add it here: this list presents itself as
 * exhaustive, and an incomplete exhaustive list licenses the reader to plan around what it omits.
 * Cited by name rather than `file:line` deliberately — these call sites move under unrelated
 * churn, and a stale line number in a security-control comment reads as authority.
 *
 * Neither notice states WHY the run is contained, and `planning_only`'s omission is the deliberate
 * one. An earlier draft opened "escalated after a status-only run was refused a document write",
 * which is true of only one of that class's two producers: `successful-run-handoff.ts` selects it
 * as `issue.workMode === "planning" || Boolean(run.statusOnlyDocumentWriteRefusedAt)`, and the
 * `workMode` arm — the older path, which that file's own comment notes "only ever fired for
 * `planning` issues" — involves no refusal and stamps nothing. So a planning-workMode issue read a
 * notice asserting a prior-run event that never happened: the PEN-3248 failure class one step
 * removed, an agent narrating an act that did not occur, on the very lane whose notice tells it to
 * confirm before claiming. Provenance is not what a reader needs from a containment notice — it
 * needs to know what will be refused — and a sentence enumerating origins rots the moment a third
 * appears. Where the origin matters it is already on the handoff record's `details`
 * (`escalatedAfterDocumentWriteRefusal`). Do not reintroduce a causal clause here.
 *
 * PEN-3275: takes the whole `contextSnapshot` rather than a class, for the same reason
 * `readRecoveryRunWriteClass` does. The status-only lane's escalation exit is conditional on the
 * snapshot carrying a `sourceIssueId`, so a notice selected by class alone could only state that
 * exit unconditionally — which is false for a reachable run, and false in the direction that sends
 * an agent into the 403 this notice exists to pre-empt. One input, one output: the class, the
 * escalation clause and the appended resume guidance are all derived here from the same object the
 * route guards will test, so they cannot disagree with each other or with enforcement.
 *
 * PEN-3275 round 4, and the one place this notice must NOT simply deter the write it names. One
 * entry in the status-only refusal list — the issue-document write — is also BLO-23197's escalation
 * SIGNAL. `assertDeliverableMutationAllowedByRunContext` (`issues.ts`) stamps
 * `statusOnlyDocumentWriteRefusedAt` only when a status-only run ACTUALLY ATTEMPTS that write and is
 * refused, and every producer of `planning_only` keys on that column — `successful-run-handoff.ts`
 * (`workMode === "planning" || Boolean(run.statusOnlyDocumentWriteRefusedAt)`) and both
 * `recovery/service.ts` paths via `documentWriteRefusedRunId`, the backstop included, so there is no
 * independent route. `workMode` reads `standard` in precisely the deadlocking case, which is why the
 * refusal itself had to become the signal.
 *
 * So announcing the refusal in advance can DISABLE the escalation it warns about: a compliant agent
 * reads the list, does not attempt the write, nothing is stamped, and the next corrective wake is
 * status-only again — BLO-23197's deadlock ("measured live on BLO-23032 and five times since")
 * restored by this notice working exactly as designed. Nothing fails when that happens: the run
 * terminates cleanly, and the BLO-23197 tests drive the guard directly so they keep passing.
 *
 * The notice therefore names the attempt as the channel rather than leaving the refusal standing as
 * a bare prohibition. Two rejected alternatives, recorded because both look cheaper:
 *
 *  - Stamp the column when the notice is RENDERED. It decouples the signal from the attempt, but it
 *    stamps on every status-only wake regardless of whether a document was ever needed, so every
 *    such run that ends without a disposition is escalated to a document-write-capable lane. That is
 *    a write-containment control failing OPEN, which is the direction this file refuses everywhere
 *    else (see `isStatusOnlyRecoveryContextSnapshot` on why `sourceIssueId` stays out of the tuple).
 *  - Add a separate "request the escalation" route. The attempt already IS that request — same
 *    stamp, same consequence, one fewer verb — so the route would be a second spelling of an
 *    existing channel, and a second spelling is the drift hazard the rest of this PR removed.
 *
 * Keep this clause. It is prose, but it is prose that carries a mechanism, and deleting it silently
 * reverts BLO-23197 with every test still green.
 */
export function recoveryRunWriteClassNotice(contextSnapshot: unknown): RecoveryRunWriteClassNoticeText | null {
  const writeClass = readRecoveryRunWriteClass(contextSnapshot);
  if (!writeClass) return null;
  const mint = (text: string) => text as RecoveryRunWriteClassNoticeText;
  if (writeClass === "planning_only") {
    return mint(
      "This wake is a planning-only recovery run. Issue document updates are permitted. Refused " +
      "with 403: creating, modifying, commenting on, resubmitting, withdrawing, linking or " +
      "unlinking approvals — every approval write, with no `request_board_approval` exception on " +
      "this lane — and all deliverable and annotation writes. Confirm any of those returned before " +
      "you describe it as done.");
  }
  return mint(
    "This wake is a cheap status-only recovery run. Reads and issue comments behave normally, so " +
    "there is no other signal that writes are contained. Refused with 403: creating, modifying, " +
    "commenting on, resubmitting, withdrawing, linking or unlinking approvals — including the " +
    "`request_board_approval` this run may itself file; assigning downstream issue work to the " +
    "cheap model profile; arming issue monitors; writing issue documents other than upserting " +
    "the status-adjudication document; and all deliverable and annotation writes. " +
    (statusOnlyEscalationSourceIssueId(contextSnapshot)
      ? "The only approval write this run can perform is creating a `request_board_approval` " +
        "linked to this run's source issue and to no other issue, and that is a single call you " +
        "cannot follow up from here — not even to comment on what you just filed. "
      : "This run's context carries no source issue, so the `request_board_approval` escalation is " +
        "refused here too: this run has no approval write available at all. ") +
    "Permitted: reads, issue comments, and recording a status disposition. " +
    "One of those refusals is also the only escalation channel off this lane: if the work this run " +
    "must finish genuinely needs an issue-document write, attempt it rather than skipping it on " +
    "the strength of this notice. The refusal is recorded against this run, and the next " +
    "corrective wake for it is dispatched planning-only, which can perform the write. An attempt " +
    "you never make is never recorded, and the wake after it is status-only again. " +
    statusOnlyRecoveryResumeGuidance(contextSnapshot).resumeGuidance +
    " Confirm any of the refused writes returned before you describe it as done: composing the " +
    "claim before the call lands is how a refused write becomes a false record.");
}

const RECOVERY_MODEL_PROFILE_HINT_KEYS = [
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
  RECOVERY_WORK_CLASS_KEY,
] as const;

// The block `mergeCoalescedContextSnapshot` drops as a unit when the incoming
// wake declares a run class. Exported so the merge and this module cannot drift:
// a key added here without the merge knowing about it is exactly the partial
// tuple this block exists to prevent.
export const RECOVERY_GUARD_CONTEXT_KEYS: readonly RecoveryModelProfileHintKey[] =
  RECOVERY_MODEL_PROFILE_HINT_KEYS;

type RecoveryModelProfileHintKey = (typeof RECOVERY_MODEL_PROFILE_HINT_KEYS)[number];
type WithoutRecoveryModelProfileHints<T> = Omit<T, RecoveryModelProfileHintKey>;

export function scrubRecoveryModelProfileHints<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryModelProfileHints<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_MODEL_PROFILE_HINT_KEYS) {
    delete output[key];
  }
  return output as WithoutRecoveryModelProfileHints<T>;
}

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryModelProfileHints<T> & { [RECOVERY_WORK_CLASS_KEY]: "normal_model" };
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "planning_only",
): WithoutRecoveryModelProfileHints<T> & typeof PLANNING_ONLY_RECOVERY_GUARD_CONTEXT & {
  [RECOVERY_WORK_CLASS_KEY]: "planning_only";
};
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
  modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  [RECOVERY_WORK_CLASS_KEY]: "status_only";
};
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: RecoveryModelProfileWorkClass,
):
  | (WithoutRecoveryModelProfileHints<T> & { [RECOVERY_WORK_CLASS_KEY]: "normal_model" })
  | (WithoutRecoveryModelProfileHints<T> & typeof PLANNING_ONLY_RECOVERY_GUARD_CONTEXT & {
    [RECOVERY_WORK_CLASS_KEY]: "planning_only";
  })
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
    [RECOVERY_WORK_CLASS_KEY]: "status_only";
  }) {
  if (workClass === "normal_model") {
    return {
      ...scrubRecoveryModelProfileHints(input),
      [RECOVERY_WORK_CLASS_KEY]: "normal_model",
    };
  }

  if (workClass === "planning_only") {
    return {
      ...scrubRecoveryModelProfileHints(input),
      ...PLANNING_ONLY_RECOVERY_GUARD_CONTEXT,
      [RECOVERY_WORK_CLASS_KEY]: "planning_only",
    };
  }

  return {
    ...scrubRecoveryModelProfileHints(input),
    ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
    [RECOVERY_WORK_CLASS_KEY]: "status_only",
  };
}

export function recoveryAssigneeAdapterOverrides(_workClass: Extract<RecoveryModelProfileWorkClass, "status_only">) {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}

/**
 * BLO-32566. The stranded-recovery wake sites pick their work class at runtime
 * rather than passing a literal: a status-only wake cannot write an issue
 * document, so once the newest run on the issue has been refused exactly that
 * write, re-dispatching status-only guarantees the same 403 and the issue can
 * never self-heal (only a recorded disposition clears the recovery action, and
 * while it is active every wake on the issue is status-only).
 *
 * A named boolean helper rather than a fourth `withRecoveryModelProfileHint`
 * overload accepting the union: the overloads exist so each work class gets a
 * precise return type, and a union-accepting overload would hand every caller a
 * union return in exchange for a widened public API on a *cost guard*. Branching
 * here keeps each arm resolving against its own precise overload, and keeps the
 * escalation rule stated in one place instead of at six call sites.
 *
 * `planning_only` is the minimum escalation that clears the trap — normal model
 * with `allowDocumentUpdates: true`, while deliverable and annotation writes stay
 * barred. It is the same escalation BLO-23197 chose for the successful-run-handoff
 * lane, which deliberately scoped this lane out as follow-up.
 *
 * Residual, tracked as BLO-32634: the four guard keys above are set explicitly on
 * the `planning_only` arm and survive a coalesced merge intact, but `modelProfile`
 * is scrub-only. So an escalated wake that coalesces with an already-queued
 * status-only wake can carry `allowDocumentUpdates: true` while retaining
 * `modelProfile: "cheap"` — the document write still succeeds, so the trap stays
 * closed, but the run may execute on the cheap profile.
 *
 * The return type is annotated rather than inferred so the union is intentional:
 * `modelProfile` exists on the status-only arm only, which makes reading it off the
 * result a compile error instead of a silently-optional field.
 */
export function withStrandedRecoveryWakeWorkClass<T extends Record<string, unknown>>(
  input: T,
  escalateAfterRefusedDocumentWrite: boolean,
):
  | (WithoutRecoveryModelProfileHints<T> & typeof PLANNING_ONLY_RECOVERY_GUARD_CONTEXT)
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  }) {
  return escalateAfterRefusedDocumentWrite
    ? withRecoveryModelProfileHint(input, "planning_only")
    : withRecoveryModelProfileHint(input, "status_only");
}
