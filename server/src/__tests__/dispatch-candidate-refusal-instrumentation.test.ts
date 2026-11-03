import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_DISPATCH_CANDIDATE_REFUSED_METRIC,
  KNOWN_DISPATCH_CANDIDATE_REFUSAL_ARMS,
  UNKNOWN_AGENT_ID,
  UNKNOWN_DISPATCH_CANDIDATE_REFUSAL_ARM,
  normalizeDispatchCandidateRefusalArm,
  recordDispatchCandidateRefused,
  renderMetrics,
} from "../services/metrics.js";
import { describeDispatchRankReadiness, isDispatchRankReady } from "../services/dispatch-readiness.js";

/**
 * PEN-5316. `paperclip_agent_dispatch_declined_total{reason="no_claimable_run"}`
 * and `paperclip_queued_run_oldest_claimable_age_seconds` contradicted each
 * other on 27-31% of an 8 h window on the two busiest seats: the dispatcher
 * recorded that nothing could be claimed while the gauge — screening on the
 * same `isDispatchRankReady` — reported a ready run that had waited more than
 * 120 s. Exactly one of them was wrong, and nobody could say which, because
 * the decline counter carried a reason but no SUBJECT and no ARM.
 *
 * PEN-3607 closed the sibling gap one level up (every `return []` in the
 * dispatch pass now records that the pass declined) and
 * dispatch-decline-instrumentation.test.ts is the durable guard for it. This
 * file is the same guard one level down, over the per-CANDIDATE decision:
 * `claimQueuedRun` had thirteen `return null` sites and the caller could not
 * tell them apart. The counter is again the disposable half of the fix; what
 * has to hold over time is that a NEW refusal arm cannot be added silently.
 */

const HEARTBEAT_SOURCE = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

/**
 * Slice `claimQueuedRun` out of the service closure, bounded at the next
 * same-indent declaration. Same technique, and the same reason, as the slice
 * in dispatch-decline-instrumentation.test.ts: the body contains template
 * literals and regexes, so a naive brace counter mis-terminates.
 */
function readClaimFunctionSource(source: string): string {
  const start = source.indexOf("  async function claimQueuedRun(");
  expect(start, "claimQueuedRun not found — was it renamed?").toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextDecl = rest.search(/\n {2}(?:async )?function /);
  expect(nextDecl, "no following declaration — the slice would run to EOF").toBeGreaterThan(-1);
  return rest.slice(0, nextDecl);
}

function withoutCommentLines(source: string): string[] {
  return source.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) return "";
    if (!trimmed.startsWith("*") && !trimmed.startsWith("/*")) return line;
    const close = line.lastIndexOf("*/");
    if (close < 0) return "";
    const tail = line.slice(close + 2);
    return tail.trim().length > 0 ? " ".repeat(close + 2) + tail : "";
  });
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * The deepest indent `claimQueuedRun`'s OWN statements reach.
 *
 * The function body sits at 4; an `if` block at 6; the one nested block
 * (`if (issueId) { ... if (...) { ... } }`) at 8. Everything deeper is inside a
 * callback — a `db.transaction(async (tx) => ...)` or a `.then()` — whose
 * `return null` belongs to that callback and is NOT a refusal of the claim.
 *
 * This is a textual depth test, not scope analysis, and the limit is worth
 * stating: adding a third level of nesting to the function's own body would
 * make a real refusal invisible to this scan. That fails in the permissive
 * direction, which is why the count assertion below is tied to the arm list
 * rather than standing alone — the two have to move together.
 */
const OUTER_STATEMENT_MAX_INDENT = 8;

const BARE_RETURN_NULL = /\breturn null;/;

/**
 * Every bare `return null` that is a refusal of the CLAIM and does not name
 * the arm it died on.
 *
 * The one legitimate bare `return null` in the function's own scope is the
 * `refuse` helper's own body, recognised by the `onRefusal?.(arm);` line
 * directly above it. Recognising it by its neighbour rather than by a line
 * number keeps the exemption pinned to the shape that earns it.
 */
function findUnnamedRefusals(functionSource: string): number[] {
  const lines = withoutCommentLines(functionSource);
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!BARE_RETURN_NULL.test(line)) continue;
    if (indentOf(line) > OUTER_STATEMENT_MAX_INDENT) continue;
    if ((lines[index - 1] ?? "").includes("onRefusal?.(arm);")) continue;
    offenders.push(index + 1);
  }
  return offenders;
}

const claimFunctionSource = readClaimFunctionSource(HEARTBEAT_SOURCE);

describe("claimQueuedRun refusal-arm scanner", () => {
  it("names an arm on every refusal of the claim", () => {
    expect(findUnnamedRefusals(claimFunctionSource)).toEqual([]);
  });

  it("would catch a newly added unnamed refusal (negative control)", () => {
    // Without this, a scan that silently matched nothing — a renamed function,
    // a changed idiom — would look identical to a clean pass.
    const withUnnamed = [
      "  async function fake() {",
      "    const refuse = (arm) => {",
      "      onRefusal?.(arm);",
      "      return null;",
      "    };",
      "    if (a) {",
      '      return refuse("budget_blocked");',
      "    }",
      "    if (b) {",
      "      return null;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnnamedRefusals(withUnnamed)).toEqual([10]);
  });

  it("does not flag a return inside a transaction callback (false-positive control)", () => {
    // A callback's `return null` is that callback's value, not a refusal of the
    // claim. The claim's own verdict on such a branch is recorded separately,
    // beside the allocator that produced it.
    const nested = [
      "  async function fake() {",
      "    const claimed = await db.transaction(async (tx) => {",
      "          if (!(await canClaim(tx))) {",
      "            return null;",
      "          }",
      "    });",
      "  }",
    ].join("\n");
    expect(findUnnamedRefusals(nested)).toEqual([]);
  });

  it("uses only allow-listed arms at the call sites, and every named arm is reachable", () => {
    const named = [...withoutCommentLines(claimFunctionSource)
      .join("\n")
      .matchAll(/return refuse\("([a-z_]+)"\)/g)]
      .map((match) => match[1]!);

    expect(named.length).toBeGreaterThan(0);
    for (const arm of named) {
      expect(KNOWN_DISPATCH_CANDIDATE_REFUSAL_ARMS as readonly string[]).toContain(arm);
    }

    // The loop-level arms are recorded by the dispatch pass rather than by
    // `claimQueuedRun`, and the three allocator arms arrive through
    // `claimRefusalArm` rather than as literals here. Asserting the vocabulary
    // has no DEAD entry is what stops the allow-list drifting into a wish list:
    // an arm no site can emit is a label an operator will wait for forever.
    const recordedElsewhere = [
      "duplicate_dispatch_suppressed",
      "pr_review_task_in_flight",
      "slot_pool_exhausted",
      "pr_review_task_blocked",
      "run_not_queued",
    ];
    const reachable = new Set([...named, ...recordedElsewhere]);
    expect([...KNOWN_DISPATCH_CANDIDATE_REFUSAL_ARMS].filter((arm) => !reachable.has(arm))).toEqual([]);
  });

  it("records the loop-level arms the claim path never sees", () => {
    // Both leave their row where the claimable gauge can keep counting it, so
    // they are the arms that can SUSTAIN a gauge over-report. If either stops
    // being recorded, the fork this instrumentation exists to settle loses the
    // side of the evidence that argues for (a).
    const dispatchSource = HEARTBEAT_SOURCE.slice(
      HEARTBEAT_SOURCE.indexOf("async function startNextQueuedRunForAgent("),
    );
    expect(dispatchSource).toContain('noteCandidateRefusal(queuedRun, "duplicate_dispatch_suppressed")');
    expect(dispatchSource).toContain('noteCandidateRefusal(queuedRun, "pr_review_task_in_flight")');
  });

  it("puts the rejected run ids on the decline log line, which is the join key", () => {
    // `run_id` cannot be a metric label (unbounded), so the counter carries the
    // arm distribution and the log carries the subject. Losing the subject
    // would leave the counter unable to be reconciled against the gauge —
    // which is the entire defect, with better labels.
    const dispatchSource = HEARTBEAT_SOURCE.slice(
      HEARTBEAT_SOURCE.indexOf("async function startNextQueuedRunForAgent("),
    );
    expect(dispatchSource).toContain("candidateRefusals,");
    // The exact total must travel beside the capped list, or a cap reads as a
    // short queue.
    expect(dispatchSource).toContain("candidateCount: candidateRefusalCount,");
  });
});

describe("recordDispatchCandidateRefused", () => {
  it("emits a bounded agent_id and arm, and appears in the Prometheus exposition", async () => {
    const agentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const labels = recordDispatchCandidateRefused({
      agentId,
      arm: "slot_pool_exhausted",
      knownAgentIds: new Set([agentId]),
    });

    expect(labels).toEqual({ agent_id: agentId, arm: "slot_pool_exhausted" });

    const { body } = await renderMetrics();
    expect(body).toMatch(
      new RegExp(
        `${AGENT_DISPATCH_CANDIDATE_REFUSED_METRIC}[^\\n]*agent_id="${agentId}"[^\\n]*arm="slot_pool_exhausted"`,
      ),
    );
  });

  it("collapses an agent outside the known roster, so a stale id cannot inflate cardinality", () => {
    const labels = recordDispatchCandidateRefused({
      agentId: "99999999-9999-9999-9999-999999999999",
      arm: "dependency_blocked",
      knownAgentIds: new Set(),
    });
    expect(labels.agent_id).toBe(UNKNOWN_AGENT_ID);
    expect(labels.arm).toBe("dependency_blocked");
  });

  it("collapses an unknown arm rather than minting a new series", () => {
    expect(normalizeDispatchCandidateRefusalArm("something_new")).toBe(
      UNKNOWN_DISPATCH_CANDIDATE_REFUSAL_ARM,
    );
    expect(normalizeDispatchCandidateRefusalArm(null)).toBe(UNKNOWN_DISPATCH_CANDIDATE_REFUSAL_ARM);
    expect(normalizeDispatchCandidateRefusalArm("slot_pool_exhausted")).toBe("slot_pool_exhausted");
  });
});

describe("describeDispatchRankReadiness", () => {
  const now = new Date("2026-11-03T00:00:00.000Z");
  const future = new Date(now.getTime() + 60_000).toISOString();

  it("names the admission-backoff arm, which is checked before dependencies", () => {
    expect(describeDispatchRankReadiness({ paperclipK8sIsolationRetryAt: future }, null, now)).toEqual({
      ready: false,
      arm: "admission_deferred",
    });
    expect(describeDispatchRankReadiness({ paperclipBranchClaimRetryAt: future }, null, now)).toEqual({
      ready: false,
      arm: "admission_deferred",
    });
  });

  it("names the dependency arm", () => {
    expect(describeDispatchRankReadiness({}, { isDependencyReady: false }, now)).toEqual({
      ready: false,
      arm: "dependency_blocked",
    });
  });

  it("reports ready for a dependency-ready row, and for the interaction-wake exemption", () => {
    expect(describeDispatchRankReadiness({}, { isDependencyReady: true }, now)).toEqual({
      ready: true,
      arm: null,
    });
    // A blocked issue is still claimable for a verified interaction wake — the
    // claim path exempts it — so the arm must say `ready`, not
    // `dependency_blocked`. Reporting the blocker here would describe the row
    // as unclaimable to an operator reading the decline record, for a row the
    // dispatcher in fact accepts.
    expect(
      describeDispatchRankReadiness(
        { wakeReason: "issue_commented", wakeCommentId: "c1" },
        { isDependencyReady: false },
        now,
      ),
    ).toEqual({ ready: true, arm: null });
    // Same blocked issue, no comment id: the exemption does not apply.
    expect(
      describeDispatchRankReadiness(
        { wakeReason: "issue_commented" },
        { isDependencyReady: false },
        now,
      ),
    ).toEqual({ ready: false, arm: "dependency_blocked" });
    // The backoff arm outranks the exemption: an interaction wake still
    // waiting out an admission stamp is not claimable either.
    expect(
      describeDispatchRankReadiness(
        { wakeReason: "issue_commented", wakeCommentId: "c1", paperclipK8sIsolationRetryAt: future },
        { isDependencyReady: false },
        now,
      ),
    ).toEqual({ ready: false, arm: "admission_deferred" });
  });

  /**
   * The boolean and the explanation must be the SAME decision, not two copies
   * of it. `dispatch-readiness.ts` exists because four previous sites each
   * re-derived this verdict slightly differently; a drifted explanation of a
   * correct verdict is the hardest version of that bug to catch, because it
   * reads as evidence.
   */
  it("never disagrees with the boolean it explains", () => {
    const snapshots: Array<Record<string, unknown>> = [
      {},
      { paperclipK8sIsolationRetryAt: future },
      { paperclipBranchClaimRetryAt: future },
      { paperclipK8sIsolationRetryAt: new Date(now.getTime() - 60_000).toISOString() },
      { wakeReason: "issue_commented", wakeCommentId: "c1" },
      { wakeReason: "not_an_interaction_wake", wakeCommentId: "c1" },
    ];
    for (const snapshot of snapshots) {
      for (const readiness of [null, { isDependencyReady: true }, { isDependencyReady: false }]) {
        expect(describeDispatchRankReadiness(snapshot, readiness, now).ready).toBe(
          isDispatchRankReady(snapshot, readiness, now),
        );
      }
    }
  });
});
