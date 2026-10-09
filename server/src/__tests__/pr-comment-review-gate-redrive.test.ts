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
  emptyGateRedriveResult,
  gateStatusIsStale,
  latestReviewerReviewAt,
  mergeSweepCounters,
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

/** The retired legacy context whose supersede post failed. */
const RETIRED_CONTEXT = "ci/ally-review";
const SECOND_RETIRED_CONTEXT = "ci/ally-review-legacy";

function gateRunner(posted = true, reason: "fetch_failed" | "retirement_failed" = "fetch_failed") {
  return vi.fn(async () =>
    posted
      ? ({ posted: true as const, verdict: { state: "success" as const, description: "clean", context: CONTEXT } })
      : reason === "retirement_failed"
        ? // The real shape: `runPrCommentReviewGateCheck` returns the failed
          // retirement posts alongside the reason so a caller can hand them to
          // the durable outbox. A fixture without them cannot observe whether
          // this caller retries them or drops them on the floor.
          ({
            posted: false as const,
            reason,
            retirementDeliveries: [
              {
                sha: "0ad8773c6ee4b2b1a0c4e9f1d2a3b4c5d6e7f809",
                context: RETIRED_CONTEXT,
                state: "failure" as const,
                description: `Superseded by ${CONTEXT}`,
                targetUrl: null,
              },
              // A SECOND delivery, because a PR can carry several retired
              // contexts and they are independent recoveries. With one, a
              // first-rejection short-circuit is indistinguishable from
              // settling them all.
              {
                sha: "0ad8773c6ee4b2b1a0c4e9f1d2a3b4c5d6e7f809",
                context: SECOND_RETIRED_CONTEXT,
                state: "failure" as const,
                description: `Superseded by ${CONTEXT}`,
                targetUrl: null,
              },
            ],
          })
        : ({ posted: false as const, reason }),
  );
}

async function run(overrides: Record<string, unknown> = {}, deps: Record<string, unknown> = {}) {
  const readStatus = (deps.readStatus as ReturnType<typeof statusReader>) ?? statusReader(STALE_STATUS_AT);
  const runGateCheck = (deps.runGateCheck as ReturnType<typeof gateRunner>) ?? gateRunner();
  const enqueueDelivery = (deps.enqueueDelivery as ReturnType<typeof vi.fn>) ?? vi.fn(async () => ({}));
  const result = await redriveStaleCommentReviewGates({
    db: {} as never,
    repoFullName: REPO,
    candidates: [candidate()],
    reviewerBotLogin: REVIEWER,
    statusContext: CONTEXT,
    logger: silentLogger,
    deps: { readStatus, runGateCheck, enqueueDelivery } as never,
    ...overrides,
  });
  return { result, readStatus, runGateCheck, enqueueDelivery };
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
      retirementRetryFailed: 0,
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

  it("hands the failed retirement posts to the durable outbox", async () => {
    // The counter records that cleanup failed; it does not fix it. A retired
    // context keeps its PREVIOUS value when its post fails, so a still-required
    // legacy context can sit red while the live gate is green — and this sweep
    // cannot re-reach it, because it probes the LIVE context only and just
    // published that. Dropping these strands the PR permanently.
    const { result, enqueueDelivery } = await run({}, { runGateCheck: gateRunner(false, "retirement_failed") });

    expect(result.retirementFailed).toBe(1);
    expect(enqueueDelivery).toHaveBeenCalledTimes(2);

    const [, delivery] = enqueueDelivery.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(delivery.repoFullName).toBe(REPO);
    expect(delivery.context).toBe(RETIRED_CONTEXT);
    expect(delivery.state).toBe("failure");
    expect(delivery.prNumber).toBe(2022);
    // `forceWrite` is what makes the row overwrite a terminal delivery for the
    // same key; without it a previously-delivered retirement is never redone.
    expect(delivery.forceWrite).toBe(true);
    // Provenance-less by construction: a retirement belongs to no company and
    // no agent run, and the outbox's NULL semantics depend on the explicit null.
    expect(delivery.companyId).toBeNull();
    expect(delivery.sourceRunId).toBeNull();
  });

  it("enqueues nothing for a clean re-drive", async () => {
    const { enqueueDelivery } = await run();

    expect(enqueueDelivery).not.toHaveBeenCalled();
  });

  it("does not double-count a candidate whose retirement enqueue throws", async () => {
    // The enqueue sits inside the per-candidate try, so an unhandled rejection
    // would fall to the outer handler and increment `failed` on a candidate
    // already counted as `redriven`. One candidate must land in exactly one.
    const enqueueDelivery = vi.fn(async () => {
      throw new Error("outbox unavailable");
    });
    const { result } = await run(
      {},
      { runGateCheck: gateRunner(false, "retirement_failed"), enqueueDelivery },
    );

    expect(result.redriven).toBe(1);
    expect(result.retirementFailed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("counts EVERY unarmed retry, so a first rejection cannot hide the rest", async () => {
    // `retirementFailed` says only that the cleanup failed: it is incremented
    // BEFORE the enqueue, so it reads identically whether the enqueue succeeded
    // or threw. Without its own counter a dropped retry — which returns the PR
    // to the pre-fix strand — is recoverable only from log text. Note the two
    // are in different units, and the assertions below are the proof: one
    // candidate is `retirementFailed === 1` with `retirementRetryFailed === 2`.
    // Two deliveries, both rejecting: `all` short-circuits on the first and the
    // second is subscribed-but-ignored, so the count is what distinguishes
    // settling them all from stopping at one.
    const enqueueDelivery = vi.fn(async () => {
      throw new Error("outbox unavailable");
    });
    const { result } = await run(
      {},
      { runGateCheck: gateRunner(false, "retirement_failed"), enqueueDelivery },
    );

    expect(enqueueDelivery).toHaveBeenCalledTimes(2);
    expect(result.retirementRetryFailed).toBe(2);
    // Still exactly one bucket for the candidate itself.
    expect(result.redriven).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("logs each unarmed cause under `err`, the only key pino serialises", async () => {
    // Not a style assertion — a guard on a measured failure. `middleware/logger.ts`
    // builds pino with neither `serializers` nor `errorKey`, so ONLY the default
    // `errorKey` ("err") is run through the error serialiser, and `message`/`stack`
    // are non-enumerable on `Error`. A batch of causes under any other key
    // (`errs: unarmed.map(e => e.err)`) therefore JSON-stringifies to `[{},{}]` —
    // verified against pino 9.14.0 with that exact config. That shape shipped once
    // already: it looks populated, and it erases every cause on the one path where
    // the PR can be left with a stale red standing. Collapsing these N lines back
    // into a single array field is the tidy-up that reintroduces it, so the `errs`
    // arm below is the half that fails when someone does.
    const warn = vi.fn();
    // Distinct message per delivery: this is the discriminator that pins each
    // cause to ITS OWN context. With both rejections carrying the same text,
    // `err: unarmed[0].err` — the shape two revisions back, one cause stapled to
    // a list of all of them — passes every other assertion here.
    let attempt = 0;
    const enqueueDelivery = vi.fn(async () => {
      attempt += 1;
      throw new Error(`outbox unavailable #${attempt}`);
    });
    await run(
      { logger: { info: () => {}, warn } },
      { runGateCheck: gateRunner(false, "retirement_failed"), enqueueDelivery },
    );

    const unarmedLines = warn.mock.calls.filter(([, msg]) =>
      String(msg).startsWith("comment-review gate retired-context retry enqueue failed"),
    );
    // One line per cause, not one line for the batch.
    expect(unarmedLines).toHaveLength(2);
    for (const [fields] of unarmedLines) {
      const line = fields as { err: unknown; context: string; contexts: string[] };
      // An Error under `err` is what pino serialises; anything else is erased.
      expect(line.err).toBeInstanceOf(Error);
      // Each cause carries its OWN context, not just the aggregate list.
      expect(line.contexts).toContain(line.context);
    }
    // Cause-to-context pairing: two distinct contexts AND two distinct causes,
    // so neither the context nor the error can be the same one repeated.
    expect(new Set(unarmedLines.map(([f]) => (f as { context: string }).context)).size).toBe(2);
    expect(
      new Set(unarmedLines.map(([f]) => ((f as { err: Error }).err).message)).size,
    ).toBe(2);
    // The batched-array shape must not come back under any message.
    expect(warn.mock.calls.some(([f]) => "errs" in (f as object))).toBe(false);
  });

  it("passes a NON-Error cause through untouched, one line each", async () => {
    // The test above only ever rejects with `Error`, the one shape pino
    // serialises richly — so it cannot see what happens to anything else.
    // `outcome.reason` from `Promise.allSettled` is unconstrained and
    // `pino-std-serializers`' `errSerializer` returns a non-Error value AS IS,
    // so the per-line split is the whole of the protection here: it is what
    // keeps a plain object's non-enumerable fields from being erased silently
    // inside a batched `errs` array, the way `[{},{}]` erased them. This pins
    // pass-through rather than asserting enrichment that does not happen —
    // a coercion or a wrapper added later must fail here and be argued for.
    const warn = vi.fn();
    const BARE_STRING = "outbox unavailable (no Error)";
    // The exact hazard Ally named: enumerable-free, so `JSON.stringify` empties
    // it. Distinct from the string so the two causes cannot be one repeated.
    const OPAQUE: Record<string, never> = {};
    Object.defineProperty(OPAQUE, "detail", { value: "erased on stringify", enumerable: false });
    let attempt = 0;
    const enqueueDelivery = vi.fn(async () => {
      attempt += 1;
      throw attempt === 1 ? BARE_STRING : OPAQUE;
    });
    await run(
      { logger: { info: () => {}, warn } },
      { runGateCheck: gateRunner(false, "retirement_failed"), enqueueDelivery },
    );

    const unarmedLines = warn.mock.calls.filter(([, msg]) =>
      String(msg).startsWith("comment-review gate retired-context retry enqueue failed"),
    );
    // One line per cause here too — a non-Error cause must not be batched.
    expect(unarmedLines).toHaveLength(2);
    const causes = unarmedLines.map(([f]) => (f as { err: unknown }).err);
    // Pass-through, by identity: neither value is wrapped, stringified, or
    // replaced with an Error on its way to the log line.
    expect(causes).toContain(BARE_STRING);
    expect(causes).toContain(OPAQUE);
    // …and this is why one line each matters: serialised, the object is empty.
    // Batched under `errs`, that `{}` is indistinguishable from the defect this
    // module was fixed for; alone under `err`, its own line still names the
    // context that produced it.
    expect(JSON.stringify(OPAQUE)).toBe("{}");
    for (const [fields] of unarmedLines) {
      const line = fields as { context: string; contexts: string[] };
      expect(line.contexts).toContain(line.context);
    }
    expect(new Set(unarmedLines.map(([f]) => (f as { context: string }).context)).size).toBe(2);
    expect(warn.mock.calls.some(([f]) => "errs" in (f as object))).toBe(false);
  });

  it("leaves retirementRetryFailed at zero when the retries are armed", async () => {
    // The negative control: without it, a counter incremented unconditionally
    // passes the positive test above on its own.
    const { result } = await run({}, { runGateCheck: gateRunner(false, "retirement_failed") });

    expect(result.retirementFailed).toBe(1);
    expect(result.retirementRetryFailed).toBe(0);
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

describe("gate re-drive result aggregation", () => {
  it("sums every counter across repos and ORs the flags", () => {
    // The tick accumulates one of these per repo. Doing it field-by-field is
    // not completeness-checked by the type system — every field is already
    // initialised to 0, so a counter added to GateRedriveResult and forgotten
    // at the call site compiles clean and reports zero fleet wide. Summing by
    // key is what removes that class, and this is its mutation point.
    const totals = emptyGateRedriveResult();

    mergeSweepCounters(totals, {
      considered: 3, probed: 2, attempted: 2, redriven: 1,
      retirementFailed: 1, retirementRetryFailed: 0, failed: 1, headless: 1, capped: false,
    });
    mergeSweepCounters(totals, {
      considered: 4, probed: 1, attempted: 1, redriven: 1,
      retirementFailed: 0, retirementRetryFailed: 2, failed: 0, headless: 2, capped: true,
    });

    expect(totals).toEqual({
      considered: 7, probed: 3, attempted: 3, redriven: 2,
      retirementFailed: 1, retirementRetryFailed: 2, failed: 1, headless: 3, capped: true,
    });
  });

  it("starts from a zeroed result with every field present", () => {
    // Asserted by whole-object equality, not field-by-field: that is what
    // forces a new counter to be added here rather than arriving as undefined
    // and turning every later `+=` into NaN.
    expect(emptyGateRedriveResult()).toEqual({
      considered: 0, probed: 0, attempted: 0, redriven: 0,
      retirementFailed: 0, retirementRetryFailed: 0, failed: 0, headless: 0, capped: false,
    });
  });

  it("does not let a later clean repo clear a flag an earlier one set", () => {
    const totals = emptyGateRedriveResult();
    mergeSweepCounters(totals, { ...emptyGateRedriveResult(), capped: true });
    mergeSweepCounters(totals, emptyGateRedriveResult());

    expect(totals.capped).toBe(true);
  });
});
