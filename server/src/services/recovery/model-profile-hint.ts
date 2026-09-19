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

// Attached to every 403 whose `details` carry `resumeRequiresNormalModel: true`.
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
// BLO-34683: the exit list is now CONDITIONAL, because the state it used to assert is not
// universal. `issue_monitor_recovery` wakes are stamped status-only while holding no recovery
// action at all, so "record a valid issue disposition to clear the recovery action" named an
// object that does not exist and left the refused run with no reachable exit but a branchless
// external ask. Both arms must stay true in both states; do not collapse this back to one.
export const STATUS_ONLY_RECOVERY_RESUME_GUIDANCE = {
  normalModelResumeIsAutomatic: false,
  resumeGuidance:
    "No normal-model run is dispatched for this issue on its own: every wake the recovery action " +
    "itself raises is status-only, and only a recorded disposition clears that action — so waiting " +
    "for a normal-model run never ends. Reachable exits from this run: if a recovery action is " +
    "active on this issue, record a valid issue disposition to clear it; if none is (a monitor-" +
    "recovery wake holds no recovery action), record your conclusion on the issue and re-arm the " +
    "wake path yourself. Either way you may file a `request_board_approval` linked to the run " +
    "context's source issue.",
} as const;

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
