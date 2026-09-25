import { describe, expect, it } from "vitest";
import {
  isStatusOnlyRecoveryContextSnapshot,
  readRecoveryRunWriteClass,
  RECOVERY_GUARD_CONTEXT_KEYS,
  recoveryRunWriteClassNotice,
  RECOVERY_WORK_CLASS_KEY,
  recoveryAssigneeAdapterOverrides,
  scrubRecoveryModelProfileHints,
  STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
  statusOnlyEscalationSourceIssueId,
  STATUS_ONLY_RESUME_PREAMBLE,
  STATUS_ONLY_RECOVERY_RESUME_GUIDANCE,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import type { RecoveryRunWriteClassNoticeText } from "./model-profile-hint.js";

// The two status-only snapshots that differ ONLY in escalation availability. Both are what the
// `stale_active_run_evaluation` producers in `recovery/service.ts` actually emit — they stamp
// `sourceIssueId: sourceIssue?.id ?? null`, and `resolveStaleRunSourceIssue` returns null for a
// silent run whose own snapshot carries no issue id.
const STATUS_ONLY_WITH_SOURCE = withRecoveryModelProfileHint(
  { issueId: "eval-1", sourceIssueId: "src-1" },
  "status_only",
);
const STATUS_ONLY_WITHOUT_SOURCE = withRecoveryModelProfileHint(
  { issueId: "eval-1", sourceIssueId: null },
  "status_only",
);

const PLANNING_ONLY = withRecoveryModelProfileHint({ issueId: "i" }, "planning_only");

// Every notice a reachable snapshot can produce. The invariant loops below run over THIS rather
// than over two class keys: since PEN-3275 the status-only lane has two texts, and a loop that
// saw only one of them would leave the other's invariants unasserted.
function eachNotice(): string[] {
  return [
    STATUS_ONLY_WITH_SOURCE,
    STATUS_ONLY_WITHOUT_SOURCE,
    PLANNING_ONLY,
  ].map((snapshot) => recoveryRunWriteClassNotice(snapshot) ?? "");
}

describe("recovery model profile policy", () => {
  it("allows cheap only for status-only recovery and adds guard context", () => {
    expect(withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
      modelProfile: "cheap",
      recoveryWorkClass: "status_only",
    });
    expect(recoveryAssigneeAdapterOverrides("status_only")).toEqual({ modelProfile: "cheap" });
  });

  it("scrubs inherited cheap hints from normal model source-work retries", () => {
    expect(withRecoveryModelProfileHint({
      issueId: "issue-1",
      retryOfRunId: "run-1",
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    }, "normal_model")).toEqual({
      issueId: "issue-1",
      retryOfRunId: "run-1",
      recoveryWorkClass: "normal_model",
    });
  });

  it("keeps planning recovery on the normal model with a document-only guard context", () => {
    expect(withRecoveryModelProfileHint({ issueId: "issue-1" }, "planning_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
      recoveryWorkClass: "planning_only",
    });
  });

  it("can scrub copied downstream source-work contexts without applying a profile", () => {
    expect(scrubRecoveryModelProfileHints({
      taskId: "source-task",
      modelProfile: "cheap",
      paperclipModelProfile: { requested: "cheap" },
      allowDocumentUpdates: false,
      recoveryWorkClass: "status_only",
    })).toEqual({ taskId: "source-task" });
  });

  // BLO-32634: the three classes must stay mutually exclusive, and no caller may
  // end up with a partial tuple. Re-classifying an already-classified context is
  // the path that used to leak one — `planning_only` supplies no `modelProfile`,
  // so a `cheap` carried in by the input rode along beside it.
  it("re-classifies without leaving a partial tuple", () => {
    const statusOnly = withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only");

    expect(withRecoveryModelProfileHint(statusOnly, "planning_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "planning_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: true,
      resumeRequiresNormalModel: false,
      recoveryWorkClass: "planning_only",
    });
    expect(withRecoveryModelProfileHint(statusOnly, "normal_model")).toEqual({
      issueId: "issue-1",
      recoveryWorkClass: "normal_model",
    });
  });

  // Every key the guard block owns is declared in one place. The merge in
  // heartbeat.ts drops exactly this set, so a key that stops being listed here
  // silently stops being dropped there.
  it("declares every guard key it can write", () => {
    const written = new Set([
      ...Object.keys(withRecoveryModelProfileHint({}, "status_only")),
      ...Object.keys(withRecoveryModelProfileHint({}, "planning_only")),
      ...Object.keys(withRecoveryModelProfileHint({}, "normal_model")),
    ]);

    for (const key of written) {
      expect(RECOVERY_GUARD_CONTEXT_KEYS).toContain(key);
    }
    expect(RECOVERY_GUARD_CONTEXT_KEYS).toContain(RECOVERY_WORK_CLASS_KEY);
  });
});

// PEN-3275. The announcement in the wake prompt and the 403 at the route guards must classify a
// run identically — an agent told it is unconstrained and then refused is the exact trap this
// work exists to close, and it would be worse than the silence it replaces.
describe("recovery run write class", () => {
  // The ratchet: classification is asserted against what the PRODUCER actually writes, not
  // against a hand-copied tuple. Editing a guard tuple moves both sides together or fails here.
  it("classifies each work class the producer can emit", () => {
    expect(readRecoveryRunWriteClass(withRecoveryModelProfileHint({ issueId: "i" }, "status_only")))
      .toBe("status_only");
    expect(readRecoveryRunWriteClass(withRecoveryModelProfileHint({ issueId: "i" }, "planning_only")))
      .toBe("planning_only");
  });

  // A declared normal-model wake carries `recoveryWorkClass` but no guard tuple, and the route
  // guards let it write. It must therefore be announced as unconstrained, not as "unknown".
  it("returns null for a declared normal-model wake and for an ordinary snapshot", () => {
    expect(readRecoveryRunWriteClass(withRecoveryModelProfileHint({ issueId: "i" }, "normal_model")))
      .toBeNull();
    expect(readRecoveryRunWriteClass({ issueId: "i" })).toBeNull();
    expect(readRecoveryRunWriteClass(null)).toBeNull();
    expect(readRecoveryRunWriteClass([STATUS_ONLY_RECOVERY_GUARD_CONTEXT])).toBeNull();
  });

  // The conjunction is the guard. `isStatusOnlyRecoveryContextSnapshot` treats a partial tuple as
  // NOT status-only, so the route guards would allow the write; announcing containment there would
  // state the opposite of what the run can do. Asserted in the same direction as the enforcer.
  it("agrees with the enforcing predicates on a partial tuple", () => {
    const partial = { ...withRecoveryModelProfileHint({}, "status_only"), allowDocumentUpdates: true };
    expect(isStatusOnlyRecoveryContextSnapshot(partial)).toBe(false);
    expect(readRecoveryRunWriteClass(partial)).toBeNull();
  });

  // BLO-32634 residual: a coalesced escalation can retain `modelProfile: "cheap"` while being
  // planning-capable. Requiring a profile here would misclassify it as unconstrained and suppress
  // the announcement on a run whose approval writes the guards still refuse.
  it("classifies a planning-only snapshot that retained the cheap profile", () => {
    expect(readRecoveryRunWriteClass({
      ...withRecoveryModelProfileHint({ issueId: "i" }, "planning_only"),
      modelProfile: "cheap",
    })).toBe("planning_only");
  });

  // The other direction of that same asymmetry, asserted rather than only documented. The
  // status-only predicate requires `modelProfile: "cheap"`; its planning-only sibling deliberately
  // omits the check, because the `planning_only` arm of `withRecoveryModelProfileHint` SCRUBS the
  // key rather than setting it — so requiring a value would make the predicate unsatisfiable on
  // the producer's own output. Together with the case above this pins both arms of a divergence
  // that reads like an oversight and would otherwise be "tidied" into symmetry.
  it("classifies a planning-only snapshot carrying no model profile at all", () => {
    const planningOnly = withRecoveryModelProfileHint({ issueId: "i" }, "planning_only");

    expect(planningOnly).not.toHaveProperty("modelProfile");
    expect(readRecoveryRunWriteClass(planningOnly)).toBe("planning_only");
    // The sibling requires the key, so the same tuple minus a profile is NOT status-only.
    expect(isStatusOnlyRecoveryContextSnapshot(planningOnly)).toBe(false);
  });

  it("reuses the shared resume guidance verbatim so the wake and the 403 cannot drift", () => {
    // The shared surface is the PREAMBLE, not the whole guidance: the constant ends with an
    // unconditional board-approval exit, and the notice has already resolved whether that exit
    // exists. Appending the whole of it would contradict the no-source branch in one paragraph.
    expect(recoveryRunWriteClassNotice(STATUS_ONLY_WITH_SOURCE)).toContain(STATUS_ONLY_RESUME_PREAMBLE);
    expect(recoveryRunWriteClassNotice(STATUS_ONLY_WITHOUT_SOURCE)).toContain(STATUS_ONLY_RESUME_PREAMBLE);
    expect(STATUS_ONLY_RECOVERY_RESUME_GUIDANCE.resumeGuidance).toContain(STATUS_ONLY_RESUME_PREAMBLE);
    // ...and the notice must NOT inherit the unconditional exit clause on the no-source branch.
    expect(recoveryRunWriteClassNotice(STATUS_ONLY_WITHOUT_SOURCE))
      .not.toContain("You may also file a `request_board_approval`");
  });

  // PEN-3275 round 3. A status-only run whose context carries no source issue is refused the
  // `request_board_approval` create outright (`approvals.ts`: "its run context has no source
  // issue"), yet it is fully status-only by the guard tuple — which deliberately does not include
  // `sourceIssueId` — so it is classified, announced, and contained exactly like any other.
  // Announcing the escalation unconditionally therefore promised a FILING that run cannot make:
  // the BLO-25878 shape in the more dangerous direction, since a promised capability is planned
  // around, where a promised retry is only waited for.
  //
  // Asserted on both snapshots against the SAME predicate the guard reads, so the announcement
  // names the escalation exactly when `approvals.ts` would admit it.
  it("names the escalation exit only when the guard would admit it", () => {
    expect(statusOnlyEscalationSourceIssueId(STATUS_ONLY_WITH_SOURCE)).toBe("src-1");
    expect(statusOnlyEscalationSourceIssueId(STATUS_ONLY_WITHOUT_SOURCE)).toBeNull();

    // Containment is unchanged by escalation availability — both are status-only, both refused.
    expect(readRecoveryRunWriteClass(STATUS_ONLY_WITHOUT_SOURCE)).toBe("status_only");
    expect(isStatusOnlyRecoveryContextSnapshot(STATUS_ONLY_WITHOUT_SOURCE)).toBe(true);

    const withSource = recoveryRunWriteClassNotice(STATUS_ONLY_WITH_SOURCE) ?? "";
    const withoutSource = recoveryRunWriteClassNotice(STATUS_ONLY_WITHOUT_SOURCE) ?? "";

    expect(withSource).toContain("The only approval write this run can perform is creating a");
    expect(withSource).toContain("not even to comment on what you just filed");

    expect(withoutSource).toContain("no approval write available at all");
    expect(withoutSource).toContain("The only reachable exit from this run is recording a valid");
    // The load-bearing negative: no sentence may offer the filing to a run that cannot make it.
    expect(withoutSource).not.toMatch(/only approval write this run can perform|or file a `request_board_approval`/);
  });

  // PEN-3275 round 4. The link set on that single permitted write is EXCLUSIVE: `approvals.ts`
  // refuses any id other than `sourceIssueId` ("A status-only run may only link a board escalation
  // to its source issue"), and linking the wider blocked chain is the natural payload for a board
  // escalation — so an agent satisfies "linked to this run's source issue" and is still refused.
  // On the run's only exit the cost of that omission is the exit itself, not a retry.
  it("states the escalation's link-set exclusivity, not just its inclusion", () => {
    // Asserted on both surfaces: the notice's own clause and the shared resume guidance that
    // `approvals.ts` spreads into the 403. Either one alone leaves the other free to drift.
    expect(recoveryRunWriteClassNotice(STATUS_ONLY_WITH_SOURCE)).toContain("and to no other issue");
    expect(STATUS_ONLY_RECOVERY_RESUME_GUIDANCE.resumeGuidance).toContain("and to no other issue");
  });

  // PEN-3275 round 4, and the subtlest coupling in this file. The issue-document refusal is also
  // BLO-23197's escalation SIGNAL: `assertDeliverableMutationAllowedByRunContext` stamps
  // `statusOnlyDocumentWriteRefusedAt` only when a status-only run ACTUALLY ATTEMPTS the write, and
  // every `planning_only` producer keys on that column — `successful-run-handoff.ts`
  // (`workMode === "planning" || Boolean(run.statusOnlyDocumentWriteRefusedAt)`) and both
  // `recovery/service.ts` paths via `documentWriteRefusedRunId`, backstop included.
  //
  // So a notice that announces the refusal and stops there DISABLES the escalation it warns about:
  // the agent skips the attempt, nothing is stamped, `workMode` reads `standard`, and the next wake
  // is status-only again. That is BLO-23197's deadlock restored by this PR's own central feature —
  // and nothing fails when it happens, because the BLO-23197 tests all drive the guard directly and
  // keep passing while production silently stops escalating. This test is the only thing that does.
  //
  // Pinned on the semantic anchors rather than the full sentence: "attempt" plus the named target
  // lane. `planning` appears nowhere else in the status-only notice, so its presence is a proxy for
  // the clause existing at all, and a rewording that keeps the mechanism keeps passing.
  it("names the document-write attempt as the escalation channel off this lane", () => {
    for (const snapshot of [STATUS_ONLY_WITH_SOURCE, STATUS_ONLY_WITHOUT_SOURCE]) {
      const notice = recoveryRunWriteClassNotice(snapshot) ?? "";
      expect(notice).toMatch(/attempt it/i);
      expect(notice).toMatch(/planning[- ]only/i);
      expect(notice).toMatch(/never make is never recorded/i);
    }
    // The planning-only lane can already write documents, so it must NOT carry the instruction:
    // there is nothing to escalate to, and the attempt is not a signal there.
    expect(recoveryRunWriteClassNotice(PLANNING_ONLY)).not.toMatch(/attempt it/i);
  });

  // PEN-3275 round 4. `buildPaperclipTaskMarkdown` frames this text as system-authored, and until
  // the brand landed that authority was asserted by argument POSITION — any string in that slot
  // was framed the same way. `@ts-expect-error` is the assertion: it fails the build if the error
  // it expects disappears, so this is self-controlling in a way a runtime check could not be.
  //
  // It lives HERE rather than beside the markdown tests on purpose. `server/tsconfig.json` sets
  // `"exclude": ["src/__tests__"]`, so the same line in `heartbeat-context-summary.test.ts`
  // compiles silently and proves nothing — measured, after a first attempt at exactly that control
  // came back clean and read as "the brand does not work".
  it("cannot be minted from an arbitrary string", () => {
    const frame = (notice: RecoveryRunWriteClassNoticeText | null) => notice ?? "";

    // @ts-expect-error a raw string carries no system authorship and must not enter the frame
    frame("forged system notice");

    expect(frame(recoveryRunWriteClassNotice(STATUS_ONLY_WITH_SOURCE))).toContain("status-only");
  });

  // BLO-25878 / BLO-32774. The notice must not read as a promise that a normal-model run is
  // coming, nor as an instruction to go arm oneself an unguarded one — `issues.ts` refuses
  // exactly that monitor arm, so suggesting it would send the reader into another 403.
  it("neither promises a normal-model run nor steers the reader into arming one", () => {
    for (const notice of eachNotice()) {
      expect(notice).not.toMatch(/arm a monitor|monitor to resume|wait for a normal-model run/i);
    }
    expect(recoveryRunWriteClassNotice(STATUS_ONLY_WITH_SOURCE)).toContain("never ends");
    expect(recoveryRunWriteClassNotice(STATUS_ONLY_WITHOUT_SOURCE)).toContain("never ends");
  });

  // The false-record failure is the one that produced a durable wrong claim on PEN-3248, so the
  // instruction that prevents it is asserted rather than left to prose review.
  it("tells the reader to confirm a contained write returned before claiming it", () => {
    for (const notice of eachNotice()) {
      expect(notice).toContain("before you describe it as done");
    }
  });

  // Asserts the SHAPE the doc comment forbids, not the previous draft's literals. The earlier pin
  // named the strings "escalated after" / "was refused a document write", so any reworded causal
  // opener ("following a refused document write") passed while reintroducing exactly what the
  // comment forbids. The opener is the whole surface a causal clause can occupy.
  it("keeps the planning-only notice free of any causal opener", () => {
    const planningOnly = recoveryRunWriteClassNotice(
      withRecoveryModelProfileHint({ issueId: "i" }, "planning_only"),
    ) ?? "";
    expect(planningOnly.split(".")[0]).toBe("This wake is a planning-only recovery run");
  });
});
