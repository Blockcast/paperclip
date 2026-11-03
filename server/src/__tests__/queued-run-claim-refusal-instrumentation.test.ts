import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizeQueuedRunClaimRefusals } from "../services/heartbeat.js";
import {
  type ClaimableSubjectLogState,
  planClaimableSubjectLogs,
} from "../services/queued-run-age-metrics.js";
import {
  KNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARMS,
  QUEUED_RUN_CLAIM_REFUSED_METRIC,
  type QueuedRunClaimRefusalArm,
  UNKNOWN_AGENT_ID,
  UNKNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARM,
  normalizeQueuedRunClaimRefusalArm,
  recordQueuedRunClaimRefused,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-5316. `paperclip_queued_run_oldest_claimable_age_seconds` screens on
 * `isDispatchRankReady` and asserts a ready run HAS been waiting;
 * `paperclip_agent_dispatch_declined_total{reason="no_claimable_run"}` asserts
 * the pass found nothing to claim. On the two busiest seats both read positive
 * on 27-31% of samples across an 8 h window, and exactly one of them is wrong —
 * which changes the remedy completely, and changes whether the
 * `HeartbeatRunQueueAgent*` alert family has been measuring dispatch wait at
 * all.
 *
 * The two could not be joined because the decline counter carried a reason and
 * no subject. These tests cover the join: the per-candidate counter, and — the
 * durable half — a source guard that a NEW refusal arm cannot be added to
 * `claimQueuedRun` without naming itself. That is the same failure mode
 * PEN-3607 found on the pass-level counter, one level down: fifteen silent
 * `return []` sites accumulated one at a time, each individually reasonable.
 */

const HEARTBEAT_SOURCE = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

/**
 * Slice `claimQueuedRun` out of the service closure. Bounded by the next
 * same-indent `function`/`async function` declaration rather than by brace
 * matching, for the reason the sibling scanner in
 * `dispatch-decline-instrumentation.test.ts` gives: the body contains template
 * literals and regexes, so a naive brace counter mis-terminates.
 */
export function readClaimQueuedRunSource(source: string): string {
  const start = source.indexOf("  async function claimQueuedRun(");
  if (start < 0) throw new Error("claimQueuedRun not found in heartbeat.ts");
  const rest = source.slice(start + 1);
  const nextDecl = rest.search(/\n {2}(?:async )?function [A-Za-z]/);
  return nextDecl < 0 ? source.slice(start) : rest.slice(0, nextDecl);
}

/** Strip whole-line comments so a comment cannot vouch for a return. */
function withoutCommentLines(functionSource: string): string[] {
  return functionSource.split("\n").map((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")
      ? ""
      : line;
  });
}

const RETURN_NULL = /^\s*return null;\s*$/;
const ANY_RETURN = /^\s*return\b/;
/**
 * The one permitted hand-off: the PR-review task gate sets a flag and returns
 * out of the enclosing DB transaction, not out of `claimQueuedRun`. The shared
 * `!claimed` site reads that flag and reports the arm. Named explicitly so the
 * exemption is a listed fact rather than a hole in the scanner.
 */
const REFUSAL_MARKERS = /onRefusal\?\.\(|claimAttempt\.prReviewTaskHeld = true/;

/** How far back an arm report may sit from the `return null` it explains. */
const LOOKBACK_LINES = 12;

/**
 * Every `return null;` in `claimQueuedRun` that does not report an arm.
 *
 * The backward scan stops at any earlier `return`, so an instrumented refusal
 * can never vouch for a silent one beneath it — the masking the sibling
 * scanner's one-line window exists to prevent, restated for a wider window.
 */
export function findUnnamedClaimRefusals(functionSource: string): number[] {
  const lines = withoutCommentLines(functionSource);
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!RETURN_NULL.test(line)) continue;
    let named = false;
    for (let back = index - 1; back >= 0 && back >= index - LOOKBACK_LINES; back--) {
      const candidate = lines[back]!;
      if (REFUSAL_MARKERS.test(candidate)) {
        named = true;
        break;
      }
      if (ANY_RETURN.test(candidate)) break;
    }
    if (!named) offenders.push(index + 1);
  }
  return offenders;
}

/**
 * Every arm literal `claimQueuedRun` actually reports.
 *
 * Two regions, because the arm is not always written inline at the call: the
 * shared post-claim site computes it into a `QueuedRunClaimRefusalArm`-typed
 * const first, so that the report sits next to its `return null` where the
 * guard above can see it.
 *
 * Comments are stripped BEFORE the regions are cut, not after. A region ends at
 * the first `;`, and prose containing one would otherwise truncate the match
 * mid-ternary and drop every arm below it — which is how the last two arms of
 * that site went missing on this scanner's first run. Same principle as the
 * guard above: a comment must never be able to change what the scanner sees.
 *
 * Comparison operands are stripped too. That site branches on
 * `externalRefusal.cause === "task_held"`, and those causes are NOT arms —
 * counting them would fail the allow-list cross-check against names that were
 * never meant to be series.
 */
export function readReportedArms(functionSource: string): string[] {
  // Terminated on `);` / `;` rather than the first `)`: the shared post-claim
  // site passes a ternary containing `hasExternalLifecycle(agent.adapterType)`,
  // so a first-paren match stops before the literals and silently reports that
  // several arms are never used.
  const source = withoutCommentLines(functionSource).join("\n");
  const regions = [
    ...source.matchAll(/onRefusal\?\.\(([\s\S]*?)\);/g),
    ...source.matchAll(/: QueuedRunClaimRefusalArm = ([\s\S]*?);\n/g),
  ];
  return regions.flatMap((match) =>
    [...match[1]!.replace(/===\s*"[^"]*"/g, "").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!));
}

/**
 * Slice the dispatch candidate loop out of `startNextQueuedRunForAgent`.
 *
 * `claimQueuedRun` is not the only thing that can refuse a ranked candidate —
 * the loop screens some of them before the claim is ever attempted, and those
 * skips reported NOTHING until review caught it. That silence was read as "the
 * dispatcher never reached this run", i.e. fork (b), when
 * `isDispatchRankReady` screens neither skip and the honest reading is fork
 * (a). A scanner over `claimQueuedRun` alone could never have seen it, which is
 * exactly why this second one exists.
 */
export function readDispatchCandidateLoopSource(source: string): string {
  const start = source.indexOf("        for (const queuedRun of prioritizedRuns) {");
  if (start < 0) throw new Error("dispatch candidate loop not found in heartbeat.ts");
  const rest = source.slice(start);
  const end = rest.indexOf("\n      } catch (err) {");
  if (end < 0) throw new Error("dispatch candidate loop end not found in heartbeat.ts");
  return rest.slice(0, end);
}

const LOOP_EXIT = /^\s*(?:continue|break);\s*$/;
/**
 * What counts as naming a candidate exit.
 *
 * `notePreClaimSkip` is the loop's own screens; `noteQueuedRunClaimRefused` is
 * the claim path's arms being drained after `claimQueuedRun` returns; and
 * `passStoppedEarly` is the two guard breaks, which are not refusals at all —
 * they stop the pass, and the `no_claimable_run` line reports that separately
 * so an untried candidate is never mistaken for a refused one.
 */
const CANDIDATE_EXIT_MARKERS =
  /notePreClaimSkip\(|noteQueuedRunClaimRefused\(|passStoppedEarly = /;

/** Leading-whitespace width, used to tell a sibling exit from a nested one. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Every arm literal the dispatch loop reports for a pre-claim skip. */
export function readLoopReportedArms(loopSource: string): string[] {
  return [...loopSource.matchAll(/notePreClaimSkip\(([\s\S]*?)\);/g)]
    .flatMap((match) => [...match[1]!.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!));
}

/**
 * Every `continue`/`break` in the candidate loop that drops a candidate without
 * recording what became of it.
 *
 * The backward scan stops at an earlier exit at the SAME OR SHALLOWER indent —
 * that one closes a different branch, so its record cannot vouch for this line.
 * A DEEPER exit is a nested branch that was not taken on the path reaching
 * here, so the record above it still governs. Without that distinction the
 * `if (!claimed) { … break; } continue;` pair reports a false positive, since
 * both exits are covered by the same refusal drain above them.
 */
export function findUnnamedCandidateSkips(loopSource: string): number[] {
  const lines = withoutCommentLines(loopSource);
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!LOOP_EXIT.test(line)) continue;
    let named = false;
    for (let back = index - 1; back >= 0 && back >= index - LOOKBACK_LINES; back--) {
      const candidate = lines[back]!;
      if (CANDIDATE_EXIT_MARKERS.test(candidate)) {
        named = true;
        break;
      }
      // Same masking rule as the claim scanner: an instrumented exit must not
      // vouch for a silent one below it — but only a sibling can mask.
      if (LOOP_EXIT.test(candidate) && indentOf(candidate) <= indentOf(line)) break;
    }
    if (!named) offenders.push(index + 1);
  }
  return offenders;
}

describe("recordQueuedRunClaimRefused", () => {
  it("emits a bounded agent_id and arm, and appears in the Prometheus exposition", async () => {
    const agentId = "29033747-e513-46d5-8a13-dcb5dac10017";
    const labels = recordQueuedRunClaimRefused({
      agentId,
      arm: "pause_hold",
      knownAgentIds: new Set([agentId]),
    });

    expect(labels).toEqual({ agent_id: agentId, arm: "pause_hold" });

    const { body } = await renderMetrics();
    expect(body).toMatch(
      new RegExp(
        `${QUEUED_RUN_CLAIM_REFUSED_METRIC}[^\\n]*agent_id="${agentId}"[^\\n]*arm="pause_hold"`,
      ),
    );
  });

  it("collapses an agent outside the known roster, so a stale id cannot inflate cardinality", () => {
    const labels = recordQueuedRunClaimRefused({
      agentId: "99999999-9999-9999-9999-999999999999",
      arm: "claim_cas_lost",
      knownAgentIds: new Set(),
    });
    expect(labels.agent_id).toBe(UNKNOWN_AGENT_ID);
    expect(labels.arm).toBe("claim_cas_lost");
  });

  it("collapses an unlisted arm rather than minting a new series", () => {
    expect(normalizeQueuedRunClaimRefusalArm("something_new")).toBe(
      UNKNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARM,
    );
    expect(normalizeQueuedRunClaimRefusalArm(null)).toBe(UNKNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARM);
    expect(normalizeQueuedRunClaimRefusalArm("pause_hold")).toBe("pause_hold");
  });
});

describe("claimQueuedRun refusal arms", () => {
  const claimSource = readClaimQueuedRunSource(HEARTBEAT_SOURCE);

  it("names an arm on every refusal", () => {
    // If this fails, a `return null` was added to claimQueuedRun without
    // reporting which screen produced it. That run then disappears from the
    // pass with no subject — the exact gap that left the gauge/dispatcher
    // disagreement unresolvable from outside the process.
    expect(findUnnamedClaimRefusals(claimSource)).toEqual([]);
  });

  it("reports only arms the metric's allow-list knows", () => {
    // A typo'd arm is worse than a missing one: it still increments, collapsing
    // to "other", so the series looks healthy while the population it was meant
    // to separate is silently merged back together.
    const reported = new Set(readReportedArms(claimSource));
    expect(reported.size).toBeGreaterThan(0);
    const unlisted = [...reported].filter(
      (arm) => !(KNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARMS as readonly string[]).includes(arm),
    );
    expect(unlisted).toEqual([]);
  });

  it("keeps the two arms isDispatchRankReady also screens, so the gauge can be compared on them", () => {
    // These two are the control population. The gauge applies the same screens,
    // so a non-zero rate on them is a refresh-window race between the two
    // readers rather than a drift between the predicates — and that difference
    // is the whole point of labelling the arm.
    const reported = new Set(readReportedArms(claimSource));
    expect(reported.has("admission_deferred")).toBe(true);
    expect(reported.has("dependency_blocked")).toBe(true);
  });

  it("separates a lost race from a screen the gauge does not apply", () => {
    // Collapsing these into one arm would make fork (a) and fork (b)
    // indistinguishable, which is the state PEN-5316 was filed to end.
    const reported = new Set(readReportedArms(claimSource));
    expect(reported.has("claim_cas_lost")).toBe(true);
    expect(reported.has("pause_hold")).toBe(true);
    expect(reported.has("stale_issue")).toBe(true);
  });

  it("splits the external-lifecycle refusal instead of merging three findings", () => {
    // The two busiest seats in the filing run `claude_k8s`, which IS an
    // external-lifecycle adapter — so a single `external_lifecycle_claim_refused`
    // would have swallowed almost the entire population this PR exists to
    // separate, on exactly the seats it was filed about. Task-held is fork (a),
    // a row that left the queue is an ordinary CAS loss, and an exhausted pool
    // is fork (b) with the GLOBAL pool as the constraint.
    const reported = new Set(readReportedArms(claimSource));
    expect(reported.has("external_lifecycle_pr_review_task_held")).toBe(true);
    expect(reported.has("external_lifecycle_slots_exhausted")).toBe(true);
    expect(reported.has("claim_cas_lost")).toBe(true);
  });
});

describe("dispatch candidate loop skips", () => {
  const loopSource = readDispatchCandidateLoopSource(HEARTBEAT_SOURCE);

  it("records what became of every candidate it drops", () => {
    // If this fails, the loop gained a `continue`/`break` that silently drops a
    // ranked candidate. That silence is not neutral: the reading rule treats an
    // absent refusal as evidence about the DISPATCHER, so an unnamed skip votes
    // for fork (b) — and both skips that existed when this PR was first opened
    // were in fact fork (a).
    expect(findUnnamedCandidateSkips(loopSource)).toEqual([]);
  });

  it("names the two pre-claim screens isDispatchRankReady does not apply", () => {
    expect(loopSource).toContain("\"pr_review_task_in_flight\"");
    expect(loopSource).toContain("\"duplicate_dispatch_suppressed\"");
  });

  it("splits the duplicate skip by which pass moved the row", () => {
    // Neither duplicate arm is fork (a): the row leaves the queue on that path,
    // so the gauge is not aging it and counting them as gauge error would
    // inflate it with rows the gauge never reported on. They are split only to
    // say whether THIS pass cancelled the duplicate or lost the CAS to a
    // concurrent one — which measures replica contention, not the fork.
    //
    // The orientation is pinned, not just the pair: the CANCELLED branch must
    // keep `duplicate_dispatch_suppressed`, because that is the name this path
    // already writes on the cancelled row's error_code and on
    // paperclip_heartbeat_duplicate_dispatch_suppressed_total. Inverting them
    // makes the obvious join return disjoint sets, which is how a label stops
    // meaning what a reader assumes it means.
    expect(loopSource).toContain("\"duplicate_dispatch_cas_lost\"");
    expect(loopSource).toContain(
      "cancelled ? \"duplicate_dispatch_suppressed\" : \"duplicate_dispatch_cas_lost\"",
    );
  });

  it("marks a pass that stopped early, so untried candidates are not read as refused", () => {
    expect(loopSource).toContain("passStoppedEarly = \"slots_filled\"");
    expect(loopSource).toContain("passStoppedEarly = \"dispatch_stopped\"");
  });

  it("leaves no allow-listed arm unreachable, and reports none the allow-list lacks", () => {
    // Both directions, over BOTH reporting sites. A reported arm missing from
    // the allow-list collapses to "other" and silently merges populations; an
    // allow-listed arm nothing reports is a series that will read zero forever
    // and be mistaken for evidence of absence.
    const reported = new Set([
      ...readReportedArms(readClaimQueuedRunSource(HEARTBEAT_SOURCE)),
      ...readLoopReportedArms(loopSource),
    ]);
    const allowed = new Set<string>(KNOWN_QUEUED_RUN_CLAIM_REFUSAL_ARMS);
    expect([...reported].filter((arm) => !allowed.has(arm))).toEqual([]);
    expect([...allowed].filter((arm) => !reported.has(arm))).toEqual([]);
  });
});

describe("findUnnamedCandidateSkips", () => {
  it("flags a candidate dropped with no record", () => {
    const body = ["for (const x of xs) {", "  if (a) {", "    continue;", "  }", "}"].join("\n");
    expect(findUnnamedCandidateSkips(body)).toEqual([3]);
  });

  it("accepts a skip that records an arm", () => {
    const body = [
      "for (const x of xs) {",
      "  if (a) {",
      '    await notePreClaimSkip(x, null, "pr_review_task_in_flight");',
      "    continue;",
      "  }",
      "}",
    ].join("\n");
    expect(findUnnamedCandidateSkips(body)).toEqual([]);
  });

  it("does not let one recorded skip vouch for a silent one below it", () => {
    const body = [
      "for (const x of xs) {",
      "  if (a) {",
      '    await notePreClaimSkip(x, null, "duplicate_dispatch_suppressed");',
      "    continue;",
      "  }",
      "  if (b) {",
      "    continue;",
      "  }",
      "}",
    ].join("\n");
    expect(findUnnamedCandidateSkips(body)).toEqual([7]);
  });

  it("is not satisfied by a COMMENT quoting the record", () => {
    const body = [
      "for (const x of xs) {",
      "  if (a) {",
      '    // await notePreClaimSkip(x, null, "pr_review_task_in_flight");',
      "    continue;",
      "  }",
      "}",
    ].join("\n");
    expect(findUnnamedCandidateSkips(body)).toEqual([4]);
  });

  it("lets a record cover both exits of the same branch", () => {
    // The real shape at the claim site: a nested `break` and the enclosing
    // `continue` are alternative exits from one `if (!claimed)` block, both
    // covered by the drain above them. Treating the deeper `break` as a mask
    // would report the `continue` as silent when it is not.
    const body = [
      "for (const x of xs) {",
      "  await noteQueuedRunClaimRefused(a, b, c);",
      "  if (!claimed) {",
      "    if (escalated) {",
      "      break;",
      "    }",
      "    continue;",
      "  }",
      "}",
    ].join("\n");
    expect(findUnnamedCandidateSkips(body)).toEqual([]);
  });
});

/**
 * The join itself, end to end on the payload. The arms say WHICH screen
 * refused; this says the log line actually carries the run id that lets a
 * reader match a refusal against the claimable gauge's named subject. Ally's
 * review noted that nothing exercised that, and it is the whole point of the
 * change.
 */
describe("summarizeQueuedRunClaimRefusals", () => {
  const refusal = (runId: string, arm: QueuedRunClaimRefusalArm, issueId: string | null = null) =>
    ({ runId, issueId, arm });

  it("carries the run id of every named refusal, with its issue and arm", () => {
    const summary = summarizeQueuedRunClaimRefusals(
      [
        refusal("run-1", "pr_review_task_in_flight", "issue-1"),
        refusal("run-2", "claim_cas_lost"),
      ],
      10,
    );
    expect(summary.refusedRuns).toEqual([
      { runId: "run-1", issueId: "issue-1", arm: "pr_review_task_in_flight" },
      { runId: "run-2", issueId: null, arm: "claim_cas_lost" },
    ]);
    expect(summary.refusedRunsOmitted).toBe(0);
  });

  it("tallies arms across the whole pass, not just the named ones", () => {
    // The tally is what decides the fork; the named list is only the sample
    // that lets a reader follow one row through. Capping the list must not cap
    // the tally, or a wedged seat's verdict would be drawn from its first ten
    // candidates.
    const refusals = [
      ...Array.from({ length: 12 }, (_, i) =>
        refusal(`held-${i}`, "pr_review_task_in_flight")),
      refusal("lost-1", "claim_cas_lost"),
    ];
    const summary = summarizeQueuedRunClaimRefusals(refusals, 10);
    expect(summary.refusalArmCounts).toEqual({
      pr_review_task_in_flight: 12,
      claim_cas_lost: 1,
    });
    expect(summary.refusedRuns).toHaveLength(10);
    expect(summary.refusedRunsOmitted).toBe(3);
    expect(summary.refusedRuns.every((entry) => entry.runId.startsWith("held-"))).toBe(true);
  });

  it("reports nothing for a pass that refused nothing", () => {
    // A pass whose candidates were never offered to the claim path lands here
    // too. An empty tally is the signal to read candidatesNotAttempted rather
    // than conclude the dispatcher passed over claimable work.
    const summary = summarizeQueuedRunClaimRefusals([], 10);
    expect(summary.refusalArmCounts).toEqual({});
    expect(summary.refusedRuns).toEqual([]);
    expect(summary.refusedRunsOmitted).toBe(0);
  });
});

describe("findUnnamedClaimRefusals", () => {
  it("flags a silent refusal", () => {
    const body = ["  async function fake() {", "    if (x) {", "      return null;", "    }", "  }"].join("\n");
    expect(findUnnamedClaimRefusals(body)).toEqual([3]);
  });

  it("accepts a refusal that names its arm", () => {
    const body = [
      "  async function fake() {",
      "    if (x) {",
      '      onRefusal?.("pause_hold");',
      "      return null;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnnamedClaimRefusals(body)).toEqual([]);
  });

  it("does not let one instrumented refusal vouch for a silent one below it", () => {
    // The masking control. Without the stop-at-return rule the lookback window
    // would walk straight past line 4 and credit line 3's report to line 7.
    const body = [
      "  async function fake() {",
      "    if (x) {",
      '      onRefusal?.("pause_hold");',
      "      return null;",
      "    }",
      "    if (y) {",
      "      return null;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnnamedClaimRefusals(body)).toEqual([7]);
  });

  it("is not satisfied by a COMMENT quoting the report", () => {
    // Documentation must not be able to disarm the check it describes — the
    // same regression the sibling scanner caught in its own first commit.
    const body = [
      "  async function fake() {",
      "    if (x) {",
      '      // onRefusal?.("pause_hold");',
      "      return null;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnnamedClaimRefusals(body)).toEqual([4]);
  });
});

/**
 * The other half of the join. The arms above say which screen refused a run;
 * these say which run the gauge's published age is actually about. Neither side
 * named a subject before PEN-5316, which is why "the gauge says a ready run has
 * waited 120 s" and "the dispatcher says there is nothing to claim" could both
 * be true on the same seat for a third of the day with no way to test either.
 */
describe("planClaimableSubjectLogs", () => {
  const at = (iso: string) => new Date(iso);
  const subject = (runId: string, ageSeconds: number, issueId: string | null = null) =>
    new Map([["agent-a" as string | null, { runId, issueId, ageSeconds }]]);

  it("names the run behind a published age", () => {
    const state: ClaimableSubjectLogState = new Map();
    const lines = planClaimableSubjectLogs(
      subject("run-1", 300, "issue-1"),
      at("2026-11-03T00:00:00Z"),
      state,
    );
    expect(lines).toEqual([
      {
        agentId: "agent-a",
        runId: "run-1",
        issueId: "issue-1",
        ageSeconds: 300,
        subjectChanged: true,
        suppressedSincePreviousLog: 0,
      },
    ]);
  });

  it("stays silent below the threshold the alert family reads", () => {
    // Under 120 s the gauge is not making a claim anyone disputes, so naming
    // the subject is noise rather than evidence.
    const state: ClaimableSubjectLogState = new Map();
    expect(planClaimableSubjectLogs(subject("run-1", 119), at("2026-11-03T00:00:00Z"), state))
      .toEqual([]);
    expect(state.size).toBe(0);
  });

  it("throttles an unchanged subject and reports how many it swallowed", () => {
    const state: ClaimableSubjectLogState = new Map();
    planClaimableSubjectLogs(subject("run-1", 300), at("2026-11-03T00:00:00Z"), state);
    expect(planClaimableSubjectLogs(subject("run-1", 330), at("2026-11-03T00:00:15Z"), state))
      .toEqual([]);
    expect(planClaimableSubjectLogs(subject("run-1", 360), at("2026-11-03T00:00:30Z"), state))
      .toEqual([]);

    const resumed = planClaimableSubjectLogs(
      subject("run-1", 420),
      at("2026-11-03T00:01:30Z"),
      state,
    );
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.subjectChanged).toBe(false);
    expect(resumed[0]!.suppressedSincePreviousLog).toBe(2);
  });

  it("logs a changed subject immediately, inside the throttle window", () => {
    // The transition is the datum: it is the moment the gauge starts speaking
    // about a different run, and a join that missed it would attribute one
    // run's age to another run's refusals.
    const state: ClaimableSubjectLogState = new Map();
    planClaimableSubjectLogs(subject("run-1", 300), at("2026-11-03T00:00:00Z"), state);
    const changed = planClaimableSubjectLogs(
      subject("run-2", 300),
      at("2026-11-03T00:00:05Z"),
      state,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]!.runId).toBe("run-2");
    expect(changed[0]!.subjectChanged).toBe(true);
  });

  it("forgets a seat that stops publishing a claimable age", () => {
    // Otherwise a long-lived process accumulates one entry per agent that was
    // ever briefly backed up.
    const state: ClaimableSubjectLogState = new Map();
    planClaimableSubjectLogs(subject("run-1", 300), at("2026-11-03T00:00:00Z"), state);
    expect(state.size).toBe(1);
    planClaimableSubjectLogs(new Map(), at("2026-11-03T00:00:05Z"), state);
    expect(state.size).toBe(0);
  });
});
