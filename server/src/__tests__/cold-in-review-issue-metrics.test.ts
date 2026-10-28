/**
 * PEN-4652 — the oldest cold-`in_review` issue age gauge.
 *
 * An `in_review` issue can hold NO waiting path at all: no live run, no future
 * monitor check, no unexpired park, no queued wake, no pending interaction or
 * approval, no open recovery issue, no recent open pull request. It is finished
 * work that nothing will ever come back to.
 *
 * The state is already classified — `in_review_without_action_path` in
 * `recovery/issue-graph-liveness.ts`. What was missing is a carrier. Its only
 * consumer is the blocked-inbox attention projection, reached solely via an
 * explicit `attention=blocked` list filter, so the state renders only when some
 * OTHER blocked row depends on the cold one; and `inboxLite` excludes
 * `in_review` by design, so no heartbeat re-picks it. Measured 2026-10-24 over a
 * complete 63-row population: 25 matched a four-signal approximation of this
 * state (40%), against exactly one open `harness_liveness_escalation` out of 187
 * ever minted, naming none of them.
 *
 * These tests pin the gauge as a PROJECTION of the classifier rather than a
 * second opinion about what "cold" means. That is the property with teeth: the
 * first revision of this gauge re-derived the predicate in SQL from four
 * signals, and the classifier honours eight, so every row waiting on an
 * approval, an interaction or an open PR — the commonest legitimate `in_review`
 * waits — was published as cold. A gauge built to inform escalation policy had
 * an upper bound wearing the name of a strand rate.
 *
 * Each property below would silently restore some part of that invisibility, or
 * that over-count, if it regressed:
 *   - a LAPSED monitor (next check in the past) counts as cold, not attended —
 *     14 of the 25 measured were exactly this shape, so reading a past
 *     timestamp as attendance blinds the gauge to the half that fails most,
 *   - a monitor that is still in the future but has exhausted `maxAttempts` or
 *     passed `timeoutAt` is also cold, which the SQL approximation got wrong in
 *     the opposite direction,
 *   - EVERY ONE of the classifier's waiting paths individually suppresses the
 *     row, so the gauge cannot cry wolf over genuinely attended work,
 *   - a cold row reached twice (directly, and as some blocked row's dependency)
 *     is counted once,
 *   - a repaired row resets its agent's series to an explicit 0, so an alert can
 *     clear rather than latching above threshold forever.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { classifyIssueGraphLiveness } from "../services/recovery/issue-graph-liveness.js";
import {
  coldInReviewGaugeEntries,
  type ColdInReviewIssueRow,
} from "../services/recovery/cold-in-review-gauge.js";
import {
  __resetMetricsForTest,
  COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC,
  COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC,
  COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR,
  coldInReviewLeaderScopedExpr,
  renderMetrics,
  setColdInReviewIssueMetricsRefreshSuccess,
  setColdInReviewIssueOldestAgeMetrics,
  UNKNOWN_AGENT_ID,
} from "../services/metrics.js";

const companyId = "company-1";
const managerId = "manager-1";
const coderId = "coder-1";
const reviewId = "review-1";
const blockedId = "blocked-1";

const NOW = new Date("2026-10-24T09:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;
/** Last meaningful activity 2h before `NOW`, so the expected age is exactly 7200. */
const LAST_ACTIVITY = new Date(NOW.getTime() - 2 * ONE_HOUR_MS);

/**
 * Explicitly typed rather than inferred from a spread of
 * `Record<string, unknown>`: this file is in the GATED typecheck allowlist
 * (`server/tsconfig.tests.json`), and one fixture type assignable to both
 * `IssueLivenessIssueInput` and `ColdInReviewIssueRow` is what lets the
 * pipeline below run with no casts — so a drift in either contract surfaces
 * here as a type error instead of being erased by an `as unknown as`.
 */
interface Fixture {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  executionPolicy: Record<string, unknown> | null;
  executionState: Record<string, unknown> | null;
  lastActivityAt: Date;
  monitorNextCheckAt?: Date | null;
  monitorAttemptCount?: number | null;
  parkedUntil?: Date | null;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: coderId,
    companyId,
    name: "Coder",
    role: "engineer",
    title: null,
    status: "idle",
    reportsTo: managerId,
    ...overrides,
  };
}

const manager = agent({ id: managerId, name: "CTO", role: "cto", reportsTo: null });

function coldReview(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: reviewId,
    companyId,
    identifier: "PEN-4652",
    title: "Awaiting review",
    status: "in_review",
    assigneeAgentId: coderId,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionPolicy: null,
    executionState: null,
    lastActivityAt: LAST_ACTIVITY,
    ...overrides,
  };
}

/**
 * Drive the real pipeline end to end: classifier -> projection -> gauge.
 * Nothing here re-states the predicate, which is the point — a test that
 * recomputed "cold" locally would pass against exactly the drift this file
 * exists to stop.
 */
type ClassifierInput = Parameters<typeof classifyIssueGraphLiveness>[0];

function publish(input: Omit<ClassifierInput, "issues"> & { issues: Fixture[] }) {
  const findings = classifyIssueGraphLiveness({ now: NOW, ...input });
  const issuesById = new Map<string, ColdInReviewIssueRow>(
    input.issues.map((row) => [row.id, row]),
  );
  const entries = coldInReviewGaugeEntries(findings, issuesById, NOW);
  setColdInReviewIssueOldestAgeMetrics(entries, new Set(input.agents.map((a) => a.id)));
  return entries;
}

/**
 * Read one gauge series EXACTLY. `toContain('… 7200')` is substring matching and
 * so also passes on `7200000` — vacuous against the likeliest regression in an
 * age gauge, a dropped unit conversion. The alert thresholds raw seconds, so a
 * 1000x error would page permanently with every test green.
 */
async function gaugeValue(agentId: string): Promise<string | undefined> {
  const { body } = await renderMetrics();
  const prefix = `${COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC}{agent_id="${agentId}"} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

async function refreshSuccessValue(): Promise<string | undefined> {
  const { body } = await renderMetrics();
  const prefix = `${COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

/**
 * The `# HELP` line a scraping operator actually reads. Asserted on because
 * this is the surface that carries the alert rule to whoever writes the alert:
 * PEN-4665's defect was that the shipped guidance was WRONG, not that the
 * numbers were, so the guidance is the part that needs a regression test.
 */
async function helpLine(metric: string): Promise<string> {
  const { body } = await renderMetrics();
  const prefix = `# HELP ${metric} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
}

describe("cold in_review issue gauge (PEN-4652)", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("publishes the oldest cold in_review age off lastActivityAt", async () => {
    const row = coldReview();
    const entries = publish({ issues: [row], relations: [], agents: [agent(), manager] });

    expect(entries).toEqual([{ agentId: coderId, ageSeconds: 7200 }]);
    expect(await gaugeValue(coderId)).toBe("7200");
  });

  it("counts a LAPSED monitor as cold, and a future one as attended", async () => {
    const lapsed = coldReview({ monitorNextCheckAt: new Date(NOW.getTime() - ONE_HOUR_MS) });
    expect(
      publish({ issues: [lapsed], relations: [], agents: [agent(), manager] }),
    ).toEqual([{ agentId: coderId, ageSeconds: 7200 }]);

    const future = coldReview({ monitorNextCheckAt: new Date(NOW.getTime() + ONE_HOUR_MS) });
    expect(
      publish({ issues: [future], relations: [], agents: [agent(), manager] }),
    ).toEqual([]);
    expect(await gaugeValue(coderId)).toBe("0");
  });

  it("counts a future monitor that is already dead — timed out or out of attempts", () => {
    // `hasScheduledMonitor` rejects both; a bare `next_check_at > now` test does
    // not, which is how the SQL approximation under-counted.
    const timedOut = coldReview({
      monitorNextCheckAt: new Date(NOW.getTime() + ONE_HOUR_MS),
      executionPolicy: { monitor: { timeoutAt: new Date(NOW.getTime() - ONE_HOUR_MS).toISOString() } },
    });
    expect(
      publish({ issues: [timedOut], relations: [], agents: [agent(), manager] }),
    ).toEqual([{ agentId: coderId, ageSeconds: 7200 }]);

    const exhausted = coldReview({
      monitorNextCheckAt: new Date(NOW.getTime() + ONE_HOUR_MS),
      monitorAttemptCount: 3,
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    expect(
      publish({ issues: [exhausted], relations: [], agents: [agent(), manager] }),
    ).toEqual([{ agentId: coderId, ageSeconds: 7200 }]);
  });

  it("treats EVERY classifier waiting path as attendance, not just the four a run table can see", () => {
    const row = coldReview();
    const base = { issues: [row], relations: [], agents: [agent(), manager] };
    const waiting = [{ companyId, issueId: reviewId, status: "pending" }];
    // A pending interaction only suppresses while it is FRESH: past
    // PENDING_INTERACTION_MAX_AGE_MS (24h) the classifier routes it to the
    // stale set, which un-suppresses the row instead.
    const freshInteraction = [{ ...waiting[0], createdAt: NOW }];

    // Sanity: without a path the row IS cold, so a suppression below cannot
    // pass vacuously.
    expect(publish(base)).toHaveLength(1);

    const suppressed: Array<[string, Parameters<typeof publish>[0]]> = [
      ["active run", { ...base, activeRuns: [{ companyId, issueId: reviewId, agentId: coderId, status: "running" }] }],
      ["queued wake request", { ...base, queuedWakeRequests: [{ companyId, issueId: reviewId, agentId: coderId, status: "queued" }] }],
      ["pending interaction", { ...base, pendingInteractions: freshInteraction }],
      ["pending approval", { ...base, pendingApprovals: waiting }],
      ["open recovery issue", { ...base, openRecoveryIssues: waiting }],
      ["recent open pull request", { ...base, openPullRequestAttendance: waiting }],
    ];
    for (const [label, input] of suppressed) {
      expect(publish(input), `${label} should suppress the gauge`).toEqual([]);
    }

    // An unexpired park, and a user assignee (operator territory — the
    // classifier declines to report those at all).
    const parked = coldReview({ parkedUntil: new Date(NOW.getTime() + ONE_HOUR_MS) });
    expect(publish({ ...base, issues: [parked] })).toEqual([]);
    const userOwned = coldReview({ assigneeUserId: "user-1" });
    expect(publish({ ...base, issues: [userOwned] })).toEqual([]);
  });

  it("counts a row several blocked parents depend on exactly once", () => {
    // A cold review that blocks two rows is reported once PER BLOCKED PARENT:
    // the classifier skips the direct pass for a row that is somebody's
    // unresolved blocker (it surfaces through the parent instead), but it runs
    // that parent pass once for each. The entry list must stay a ROW count, not
    // a finding count, or one popular blocker inflates the gauge.
    const row = coldReview();
    const blockedParent = (id: string, identifier: string): Fixture =>
      coldReview({ id, identifier, title: "Waiting on the review", status: "blocked" });
    const issues = [row, blockedParent(blockedId, "PEN-0001"), blockedParent("blocked-2", "PEN-0002")];
    const relations = [
      { companyId, blockerIssueId: reviewId, blockedIssueId: blockedId },
      { companyId, blockerIssueId: reviewId, blockedIssueId: "blocked-2" },
    ];
    const findings = classifyIssueGraphLiveness({ now: NOW, issues, relations, agents: [agent(), manager] })
      .filter((finding) => finding.state === "in_review_without_action_path");

    expect(findings.length).toBeGreaterThan(1);
    expect(new Set(findings.map((finding) => finding.recoveryIssueId))).toEqual(new Set([reviewId]));
    expect(publish({ issues, relations, agents: [agent(), manager] }))
      .toEqual([{ agentId: coderId, ageSeconds: 7200 }]);
  });

  it("buckets an unassigned cold row under the UNKNOWN agent rather than dropping it", async () => {
    const row = coldReview({ assigneeAgentId: null });
    expect(publish({ issues: [row], relations: [], agents: [agent(), manager] }))
      .toEqual([{ agentId: null, ageSeconds: 7200 }]);
    expect(await gaugeValue(UNKNOWN_AGENT_ID)).toBe("7200");
  });

  it("resets a repaired agent to an explicit 0 so the alert can clear", async () => {
    const row = coldReview();
    publish({ issues: [row], relations: [], agents: [agent(), manager] });
    expect(await gaugeValue(coderId)).toBe("7200");

    // Somebody arms a monitor. The series must go to 0, not go absent and not
    // freeze at its last value.
    const repaired = coldReview({ monitorNextCheckAt: new Date(NOW.getTime() + ONE_HOUR_MS) });
    publish({ issues: [repaired], relations: [], agents: [agent(), manager] });
    expect(await gaugeValue(coderId)).toBe("0");
  });

  it("flips the freshness gauge rather than letting a stale age read as current", async () => {
    // The structural half of this property lives in `reconcileIssueGraphLiveness`:
    // the age setter is only reachable AFTER a successful snapshot read, and the
    // failure arm flips this gauge and rethrows without touching the ages. So a
    // failed pass leaves the last ages published but flagged, rather than
    // publishing a healthy-looking synthetic 0. What is checkable here is that
    // the flag itself moves in both directions.
    setColdInReviewIssueMetricsRefreshSuccess(true);
    expect(await refreshSuccessValue()).toBe("1");
    setColdInReviewIssueMetricsRefreshSuccess(false);
    expect(await refreshSuccessValue()).toBe("0");
  });

  // PEN-4665. The gauge values were never wrong; the ALERT RULE shipped in the
  // help text was. `max by (service) (<series>{service="paperclip-workers"})`
  // is correct only when leadership moves by restart, and reads a demoted but
  // still-running leader's stale `1` as healthy when the lease moves in
  // process — fail-open on an instrument whose whole job is to stop a silent
  // state being silent. These lock the corrected guidance onto the surface an
  // operator reads, and keep the retired form from creeping back.
  describe("alert guidance (PEN-4665)", () => {
    it("ships the leader-scoped join on BOTH gauges, from one shared constant", async () => {
      // One constant, embedded twice — so the two help texts cannot drift from
      // each other the way the two copies of the old rule did.
      expect(COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR)
        .toBe('and on (pod) (paperclip_scheduler_lease_held{lease="heartbeat-timer"} == 1)');

      for (const metric of [
        COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC,
        COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC,
      ]) {
        expect(await helpLine(metric), `${metric} must carry the leader-scoped selector`)
          .toContain(COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR);
      }
    });

    it("does not prescribe the retired tier-aggregate predicate on either gauge", async () => {
      // The retired form may still be NAMED as the rejected alternative — that
      // is how a reader learns not to reintroduce it — so this asserts on the
      // prescription, i.e. the full selector that used to be the recommendation.
      const retired = 'max by (service) (<series>{service="paperclip-workers"}) == 0';
      for (const metric of [
        COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC,
        COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC,
      ]) {
        expect(await helpLine(metric), `${metric} must not re-prescribe the fail-open form`)
          .not.toContain(retired);
      }
    });

    // PromQL binds comparison operators TIGHTER than `and`, so the composition a
    // reader writes by hand --
    //   <series> and on (pod) (<lease> == 1) == 0
    // -- parses as `<series> and on (pod) ((<lease> == 1) == 0)`, whose right
    // side is always empty, and is therefore an alert that can NEVER fire.
    // Reduced to a self-contained control and measured against live Prometheus
    // on 2026-10-28:
    //   vector(0) and on() (vector(1) == 1) == 0    => []        (empty)
    //   (vector(0) and on() (vector(1) == 1)) == 0  => {} 0
    // That is the same silent-instrument failure PEN-4665 exists to remove,
    // one layer up — hence the helper, and hence this test.
    it("parenthesises the join so the comparison binds to it, not to the lease gauge", () => {
      const expr = coldInReviewLeaderScopedExpr(
        COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC,
        "== 0",
      );
      expect(expr).toBe(
        `(${COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC} `
        + `${COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR}) == 0`,
      );
      // The comparison must sit OUTSIDE the closing paren of the join.
      expect(expr.indexOf("== 0")).toBeGreaterThan(expr.lastIndexOf(")") - 1);
      expect(expr.startsWith("(")).toBe(true);
    });

    // The second way to write a silent alert, and it is NOT the same mistake.
    // `and on (pod)` needs the `pod` label on both sides; `max by (agent_id)`
    // has already dropped it. So the aggregation must WRAP the join. Measured
    // against live Prometheus 2026-10-28 on a genuinely cold row (agent
    // d6f327a4, 141,381 s):
    //   max by (agent_id) (<age> and on (pod) (<lease> == 1)) > 86400  => fires
    //   max by (agent_id) (<age>) and on (pod) (<lease> == 1) > 86400  => []
    it("wraps the join in the aggregation, because `max by (agent_id)` drops `pod`", () => {
      const expr = coldInReviewLeaderScopedExpr(
        COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC,
        "> 86400",
        "max by (agent_id)",
      );
      expect(expr).toBe(
        `max by (agent_id) (${COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC} `
        + `${COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR}) > 86400`,
      );
      // The aggregation opens before the join, so `pod` still exists at join time.
      expect(expr.indexOf("max by (agent_id)")).toBeLessThan(expr.indexOf("and on (pod)"));
    });

    it("names the lease that actually gates the chain, not an invented one", async () => {
      // The join is only correct if it keys off the lease the recovery chain is
      // gated on. `heartbeat-timer` is HEARTBEAT_TIMER_LEASE in
      // `scheduler-lease.ts`, which `index.ts` passes to `schedulerLeaseHolder`
      // and whose `shouldRunLoop()` gates the timer loop that runs the chain.
      // A typo here produces an empty join and an alert that can never fire.
      expect(COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR).toContain('lease="heartbeat-timer"');
      expect(COLD_IN_REVIEW_LEADER_SCOPED_SELECTOR).toContain("paperclip_scheduler_lease_held");
    });
  });

  it("ignores statuses other than in_review", () => {
    for (const status of ["todo", "in_progress", "backlog", "done", "cancelled"]) {
      const row = coldReview({ status });
      expect(
        publish({ issues: [row], relations: [], agents: [agent(), manager] }),
        `status ${status} should not be reported as a cold review`,
      ).toEqual([]);
    }
  });
});
