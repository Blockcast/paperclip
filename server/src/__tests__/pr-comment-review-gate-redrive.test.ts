/**
 * Lost-trigger recovery for the comment-review gate (BLO-39871).
 *
 * Every fixture here is built WITHOUT a `pull_request_review` event, because
 * that is the failure under test: GitHub never delivered one. The module is
 * driven from an open-PR enumeration alone, which is the only input available
 * when the webhook never arrives.
 *
 * The two directions that must not be confused:
 *
 *  - A gate status OLDER than the reviewer's latest review is the stranded red
 *    this exists to clear. It must re-drive.
 *  - A gate status NEWER than that review is a healthy PR. It must not re-drive,
 *    or the sweep becomes a standing evaluation storm against an installation
 *    budget that is routinely exhausted — the counter-signal on the issue.
 */
import { describe, expect, it, vi } from "vitest";

const {
  DEFAULT_MAX_GATE_REDRIVES_PER_REPO,
  gateStatusIsStale,
  latestReviewerReviewAt,
  redriveStaleCommentReviewGates,
} = await import("../services/pr-comment-review-gate-redrive.js");

const REPO = "Blockcast/trafficcontrol";
const CONTEXT = "gate/ally-comment-findings";
const REVIEWER = "allyblockcast[bot]";

/** The measured incident: gate red at 06:47:35Z, clean Ally review at 07:29:34Z. */
const STALE_STATUS_AT = "2026-10-01T06:47:35Z";
const REVIEW_AT = "2026-10-01T07:29:34Z";
const FRESH_STATUS_AT = "2026-10-01T07:30:10Z";

const silentLogger = { info: () => {}, warn: () => {} };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    prNumber: 2022,
    headSha: "0ad8773c6ee4b2b1a0c4e9f1d2a3b4c5d6e7f809",
    prUrl: `https://github.com/${REPO}/pull/2022`,
    reviewsReadable: true,
    reviews: [{ authorLogin: REVIEWER, submittedAt: REVIEW_AT }],
    ...overrides,
  };
}

function statusReader(createdAt: string | null, ok = true) {
  return vi.fn(async () =>
    ok
      ? ({ ok: true as const, status: createdAt === null ? null : { state: "failure" as const, context: CONTEXT, createdAt, targetUrl: null } })
      : ({ ok: false as const, retryable: true, reason: "commit_status_read_rate_limited" }),
  );
}

function gateRunner(posted = true, reason: "fetch_failed" | "retirement_failed" = "fetch_failed") {
  return vi.fn(async () =>
    posted
      ? ({ posted: true as const, verdict: { state: "success" as const, description: "clean", context: CONTEXT } })
      : ({ posted: false as const, reason }),
  );
}

async function run(overrides: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
  const readStatus = (deps.readStatus as ReturnType<typeof statusReader>) ?? statusReader(STALE_STATUS_AT);
  const runGateCheck = (deps.runGateCheck as ReturnType<typeof gateRunner>) ?? gateRunner();
  const result = await redriveStaleCommentReviewGates({
    db: {} as never,
    repoFullName: REPO,
    candidates: [candidate()],
    reviewerBotLogin: REVIEWER,
    statusContext: CONTEXT,
    logger: silentLogger,
    deps: { readStatus, runGateCheck } as never,
    ...overrides,
  });
  return { result, readStatus, runGateCheck };
}

describe("comment-review gate lost-trigger re-drive", () => {
  it("re-drives a stale red when no review event was ever delivered", async () => {
    const { result, runGateCheck } = await run();

    expect(result.redriven).toBe(1);
    expect(result.probed).toBe(1);
    expect(result.failed).toBe(0);
    expect(runGateCheck).toHaveBeenCalledTimes(1);

    // The verdict must come from a live read of both surfaces, never from a
    // payload: no head sha is forwarded, so the gate resolves the live head and
    // re-lists the comment/review surfaces itself.
    const call = runGateCheck.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.repoFullName).toBe(REPO);
    expect(call.prNumber).toBe(2022);
    expect(call).not.toHaveProperty("headSha");
    expect(call).not.toHaveProperty("body");
  });

  it("does not re-drive when the status already postdates the latest review", async () => {
    const { result, runGateCheck } = await run({}, { readStatus: statusReader(FRESH_STATUS_AT) });

    expect(result.redriven).toBe(0);
    expect(runGateCheck).not.toHaveBeenCalled();
  });

  it("re-drives when no gate status exists at the head at all", async () => {
    const { result } = await run({}, { readStatus: statusReader(null) });
    expect(result.redriven).toBe(1);
  });

  it("costs nothing on a PR the reviewer has never reviewed", async () => {
    const { result, readStatus, runGateCheck } = await run({
      candidates: [candidate({ reviews: [{ authorLogin: "someone-else", submittedAt: REVIEW_AT }] })],
    });

    expect(result.probed).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
    expect(runGateCheck).not.toHaveBeenCalled();
  });

  it("never credits the bare user seat as the reviewer App", async () => {
    const { result, readStatus } = await run({
      candidates: [candidate({ reviews: [{ authorLogin: "allyblockcast", submittedAt: REVIEW_AT }] })],
    });

    expect(result.probed).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("fails closed on an unreadable reviews probe rather than re-driving blind", async () => {
    // The reviews list must be NON-EMPTY here. An unreadable probe paired with
    // `[]` is skipped by the no-reviewer-review branch anyway, so that fixture
    // cannot tell this guard from its absence — it survived the mutation. The
    // shape with teeth is a partial read: rows present, readability false.
    const { result, readStatus, runGateCheck } = await run({
      candidates: [
        candidate({ reviewsReadable: false, reviews: [{ authorLogin: REVIEWER, submittedAt: REVIEW_AT }] }),
      ],
    });

    expect(result.probed).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
    expect(runGateCheck).not.toHaveBeenCalled();
  });

  it("fails closed on an unreadable commit status", async () => {
    const { result, runGateCheck } = await run({}, { readStatus: statusReader(null, false) });

    expect(result.probed).toBe(1);
    expect(result.redriven).toBe(0);
    expect(runGateCheck).not.toHaveBeenCalled();
  });

  it("is a strict no-op when the gate context is not configured", async () => {
    const { result, readStatus } = await run({ statusContext: "   " });

    expect(result).toEqual({
      considered: 0,
      probed: 0,
      attempted: 0,
      redriven: 0,
      retirementFailed: 0,
      failed: 0,
      headless: 0,
      capped: false,
    });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("counts a non-posting re-drive as failed, not as recovered", async () => {
    const { result } = await run({}, { runGateCheck: gateRunner(false) });

    expect(result.redriven).toBe(0);
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("does not report a published-but-unretired re-drive as having written nothing", async () => {
    // `retirement_failed` is the one `posted: false` reason where the live
    // status DID publish; only the superseded-context cleanup failed. Counting
    // it in `failed` states the opposite of what happened for the field that
    // gets alerted on.
    const { result } = await run({}, { runGateCheck: gateRunner(false, "retirement_failed") });

    expect(result.redriven).toBe(1);
    expect(result.failed).toBe(0);
    // ...and is still distinguishable from a clean re-drive. Without its own
    // counter this outcome is identical to `redriven: 1, failed: 0` and is
    // recoverable only from log text, so a persistent cleanup failure cannot
    // be alerted on.
    expect(result.retirementFailed).toBe(1);
  });

  it("leaves retirementFailed at zero for a clean re-drive", async () => {
    const { result } = await run();

    expect(result.redriven).toBe(1);
    expect(result.retirementFailed).toBe(0);
  });

  it("isolates a throwing re-drive and keeps sweeping", async () => {
    const runGateCheck = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ posted: true, verdict: { state: "success", description: "clean", context: CONTEXT } });
    const { result } = await run(
      { candidates: [candidate(), candidate({ prNumber: 2023 })] },
      { runGateCheck },
    );

    expect(result.failed).toBe(1);
    expect(result.redriven).toBe(1);
    // A throw still consumed an evaluation's worth of budget.
    expect(result.attempted).toBe(2);
  });

  it("caps re-drives per repo per sweep", async () => {
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({ prNumber: 3000 + index }));
    const { result, runGateCheck } = await run({ candidates, maxRedrives: 2 });

    expect(runGateCheck).toHaveBeenCalledTimes(2);
    expect(result.redriven).toBe(2);
    expect(result.capped).toBe(true);
    expect(result.considered).toBe(4);
  });

  it("caps ATTEMPTS, so a repo whose re-drives all fail is bounded too", async () => {
    // The all-posting fixture above passes identically whether the cap counts
    // attempts or publishes, so it cannot fail on a cap keyed on `redriven`.
    // This one can: with a success-keyed cap the counter never moves and every
    // candidate runs a full gate evaluation, with `capped` reporting false.
    const candidates = Array.from({ length: 4 }, (_, index) => candidate({ prNumber: 3000 + index }));
    const { result, runGateCheck } = await run({ candidates, maxRedrives: 2 }, { runGateCheck: gateRunner(false) });

    expect(runGateCheck).toHaveBeenCalledTimes(2);
    expect(result.attempted).toBe(2);
    expect(result.redriven).toBe(0);
    expect(result.capped).toBe(true);
  });

  it("counts a candidate carrying no head sha instead of skipping it silently", async () => {
    // If the list payload ever stops carrying `head.sha`, every other counter
    // reads a healthy zero while the sweep re-drives nothing at all.
    const { result, readStatus } = await run({ candidates: [candidate({ headSha: null })] });

    expect(result.headless).toBe(1);
    expect(result.probed).toBe(0);
    expect(readStatus).not.toHaveBeenCalled();
  });

  it("defaults the cap rather than sweeping unbounded", () => {
    expect(DEFAULT_MAX_GATE_REDRIVES_PER_REPO).toBeGreaterThan(0);
  });
});

describe("staleness predicates", () => {
  it("takes the newest reviewer review, ignoring other authors", () => {
    expect(
      latestReviewerReviewAt(
        [
          { authorLogin: REVIEWER, submittedAt: "2026-10-01T05:00:00Z" },
          { authorLogin: "human", submittedAt: "2026-10-01T23:00:00Z" },
          { authorLogin: "app/allyblockcast", submittedAt: REVIEW_AT },
        ],
        REVIEWER,
      ),
    ).toBe(REVIEW_AT);
  });

  it("skips unparseable review timestamps instead of ranking them", () => {
    expect(
      latestReviewerReviewAt(
        [
          { authorLogin: REVIEWER, submittedAt: "not-a-date" },
          { authorLogin: REVIEWER, submittedAt: REVIEW_AT },
        ],
        REVIEWER,
      ),
    ).toBe(REVIEW_AT);
    expect(latestReviewerReviewAt([{ authorLogin: REVIEWER, submittedAt: "not-a-date" }], REVIEWER)).toBeNull();
  });

  it("treats an absent or unparseable status as stale, and a newer one as current", () => {
    expect(gateStatusIsStale(STALE_STATUS_AT, REVIEW_AT)).toBe(true);
    expect(gateStatusIsStale(FRESH_STATUS_AT, REVIEW_AT)).toBe(false);
    expect(gateStatusIsStale(null, REVIEW_AT)).toBe(true);
    expect(gateStatusIsStale("not-a-date", REVIEW_AT)).toBe(true);
    // Equal timestamps are not stale: the status already reflects that review.
    expect(gateStatusIsStale(REVIEW_AT, REVIEW_AT)).toBe(false);
  });

  it("refuses to judge against an unparseable review timestamp", () => {
    expect(gateStatusIsStale(null, "not-a-date")).toBe(false);
  });
});
