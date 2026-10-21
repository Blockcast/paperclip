import { describe, expect, it } from "vitest";
import { extractAllyReviewedHeadSha } from "./ally-review-detection.js";
import {
  buildGithubTruthProbe,
  prRefsFromWorkProducts,
  MAX_SERIAL_CALLS,
  PER_CALL_TIMEOUT_MS,
  PROBE_DEADLINE_MS,
  type GithubTruthDeps,
  type TruthWorkProduct,
} from "./evidence-truth.js";

const HEAD = "c".repeat(40);
const OLD = "a".repeat(40);
const ALLY = "allyblockcast[bot]";

const clean = `## Ally — Consolidated PR Review
**Reviewed head:** \`${HEAD}\`

### Critical Issues (0)
None.

### Important Issues (0)
None.

### Recommended Action
Land.`;
const dirty = clean.replace("Important Issues (0)", "Important Issues (1)");
// A body that attests this head but FAILS Surface 1's grammar: no `## Ally`
// consolidated-review heading, so `isAllyConsolidatedReviewComment` skips it
// and only the formal-review surface can vouch. This is the reachable
// population `formalClean` still buys — see the positive control below.
const attestedNoHeading = `Looks fine to me.
**Reviewed head:** \`${HEAD}\``;
// A blocking review of a head the branch has since replaced, carrying a real
// finding bullet so there is something to carry forward. Nothing retires it, so
// the gate must keep it red across the replacement head (BLO-29711).
const dirtyAtOld = `## Ally — Consolidated PR Review
**Reviewed head:** \`${OLD}\`

### Critical Issues (0)
None.

### Important Issues (1)
- The probe and the merge gate can disagree about one head.

### Recommended Action
Fix before merge.`;

const WEBHOOK = { promotedByActorId: "github_pull_request_webhook" };

function wp(
  over: Partial<{
    merged: boolean;
    headSha: string;
    prNumber: number;
    trust: TruthWorkProduct["sourceTrust"];
  }> = {},
): TruthWorkProduct {
  return {
    type: "pull_request",
    metadata: {
      repoFullName: "Blockcast/paperclip",
      prNumber: over.prNumber ?? 1588,
      headSha: over.headSha ?? HEAD,
      merged: over.merged ?? false,
      mergedAt: null,
    },
    sourceTrust: over.trust === undefined ? WEBHOOK : over.trust,
  };
}

function deps(o: Partial<GithubTruthDeps> = {}): GithubTruthDeps {
  return {
    fetchHeadSha: async () => HEAD,
    // The clean body sits on the REVIEWS surface, which is both what Ally
    // actually files (83 of 83 consolidated reviews measured on
    // `Blockcast/paperclip`, 2026-10-20) and what a `clean` vouch now requires
    // (PEN-4431). On the comment surface this default would reach
    // `not_evaluated`, and every test that inherits it and asserts
    // `review:ally-clean` would fail for a reason unrelated to its subject.
    listReviewerSurfaces: async () => ({
      reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
      comments: [],
    }),
    getPullRequestGate: async () => ({ state: "closed", merged: true }),
    // A PR opened by someone OTHER than the reviewer identity: the default
    // fixture is an independently-reviewed PR, so it can still reach `clean`.
    // Tests that want the self-attested shape override it.
    fetchPrAuthorLogin: async () => "some-human",
    // Throws rather than returning a value, so a test that reaches this call
    // without meaning to fails loudly instead of quietly taking a default.
    // Nothing in the default fixture declares a `reviewer`, so nothing should
    // reach it (BLO-43550).
    fetchCommitAuthorEmail: async () => {
      throw new Error("fetchCommitAuthorEmail: no fixture declares a reviewer lane");
    },
    reviewerBotLogin: ALLY,
    ...o,
  };
}

describe("prRefsFromWorkProducts", () => {
  it("dedupes by repo+number and trusts `merged` only from webhook-stamped rows", () => {
    const refs = prRefsFromWorkProducts([wp({ merged: true }), wp({ merged: true, trust: null })]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.webhookMerged).toBe(true);
    // An API-created row is a reference, not a fact: it says merged, and the
    // probe must still ask GitHub.
    expect(prRefsFromWorkProducts([wp({ merged: true, trust: null })])[0]!.webhookMerged).toBe(false);
  });

  it("ignores non-PR work products and rows without a repo or number", () => {
    expect(prRefsFromWorkProducts([{ type: "deployment", metadata: { prNumber: 1 }, sourceTrust: null }])).toEqual([]);
    expect(prRefsFromWorkProducts([{ type: "pull_request", metadata: { prNumber: 1 }, sourceTrust: null }])).toEqual([]);
    expect(
      prRefsFromWorkProducts([
        { type: "pull_request", metadata: { repoFullName: "a/b", prNumber: "12" }, sourceTrust: null },
      ]),
    ).toEqual([]);
    expect(prRefsFromWorkProducts([{ type: "pull_request", metadata: null, sourceTrust: null }])).toEqual([]);
  });
});

describe("buildGithubTruthProbe", () => {
  it("webhook-merged + a clean comment review → both shapes, and no merge call is made", async () => {
    let gateCalls = 0;
    const probe = buildGithubTruthProbe(
      deps({
        getPullRequestGate: async () => {
          gateCalls += 1;
          return { state: "closed", merged: true };
        },
      }),
    );
    const r = await probe({ workProducts: [wp({ merged: true })] });
    expect(r.detections).toEqual({ "deploy:landed": true, "review:ally-clean": true });
    expect(gateCalls).toBe(0);
    expect(r.probeFailed).toBe(false);
  });

  it("an API-created row claiming merged is confirmed against GitHub, never trusted", async () => {
    const probe = buildGithubTruthProbe(deps({ getPullRequestGate: async () => ({ state: "open", merged: false }) }));
    const r = await probe({ workProducts: [wp({ merged: true, trust: null })] });
    expect(r.detections["deploy:landed"]).toBeUndefined();
  });

  // BLO-34316. The comment surface may only vouch for a head someone OTHER
  // than the author examined. On an agent PR both sides are the reviewer
  // identity, so without this the probe credits a self-attestation as
  // `review:ally-clean` — the fabrication this module's premise forbids.
  it("a self-attested comment is not clean: the author IS the reviewer identity", async () => {
    const r = await buildGithubTruthProbe(deps({ fetchPrAuthorLogin: async () => ALLY }))({
      workProducts: [wp()],
    });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });

  // The author is read ONLY when the outcome turns on it. A head nothing
  // attests is already not-clean author-blind, so paying for the read would
  // spend a call from the probe's scarce budget to change nothing.
  it("does not read the author when no comment attests the head", async () => {
    let authorCalls = 0;
    const r = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({ reviews: [], comments: [] }),
        fetchPrAuthorLogin: async () => {
          authorCalls += 1;
          return "some-human";
        },
      }),
    )({ workProducts: [wp()] });
    expect(authorCalls).toBe(0);
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });

  // An unread author fails CLOSED. Treating an unreadable `GET /pulls/{n}` as
  // "independent" would let a transient 5xx manufacture the pass, which is the
  // one direction this probe must never get wrong.
  it("an unreadable PR author fails closed and is reported, not assumed independent", async () => {
    const r = await buildGithubTruthProbe(deps({ fetchPrAuthorLogin: async () => null }))({
      workProducts: [wp()],
    });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(true);
    expect(r.diagnostics.some((d) => d.startsWith("github-truth-probe-failed:pr_author:"))).toBe(true);
  });

  it("not merged per the webhook but merged on GitHub → detected via the confirm call", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: [wp()] });
    expect(r.detections["deploy:landed"]).toBe(true);
  });

  // The review GRAMMAR is a property of the BODY, not of the object carrying
  // it. Ally files most verdicts as formal review objects — 8 of them, and zero
  // issue comments, on this fix's own PR — so judging only `surfaces.comments`
  // computed the carried-finding rules over an EMPTY list on exactly the PRs
  // that had a finding to carry.
  //
  // This is that shape, and it is the ordinary one for an agent PR: a finding
  // raised at an older head, and the only attestation of the current head
  // written by the PR author. A self-attestation does not disposition the
  // carry, so the merge gate publishes `carried_finding` → RED — while the
  // probe, seeing an empty comment list, fell through to `formalClean` on the
  // newest review and reported `review:ally-clean` at the same head. Reverting
  // the `surfaces.reviews` merge fails this case.
  it("a finding carried on the REVIEW surface is not cleared by the author's own attestation", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => ALLY,
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: dirtyAtOld, state: "COMMENTED", commitId: OLD, submittedAt: "2026-09-06T00:00:00Z" },
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" },
          ],
          comments: [],
        }),
      }),
    );
    expect((await probe({ workProducts: [wp()] })).detections["review:ally-clean"]).toBeUndefined();
  });

  // The Suggestion's route: `authorUnknown` also rides `carried_finding`, where
  // the retained verdict is a RED rather than the withheld positive. The red
  // stands on the comment surfaces alone, so it must survive an unread author —
  // while `probeFailed` stays honest, because a readable distinct author could
  // genuinely have cleared the carry. Nothing else stops a future edit from
  // collapsing this route into the `not_evaluated` one.
  //
  // INERT against the `&& !commentBlocking` clause, not a guard for it (Ally
  // review of #2143): `reviews: []` leaves `formalAttestingReview` undefined, so
  // that `if` short-circuits on its FIRST conjunct and `!commentBlocking` is
  // never evaluated. It survives reverting the clause because Surface 2 never
  // reaches the read — not because the memo makes Surface 2 free. It IS
  // discriminating against a different mutation: moving the suppression up onto
  // Surface 1's `authorUnknown` read at :286-287 flips `probeFailed` to `false`
  // and turns this red. So do not read it as this clause's guard and delete the
  // blocking-route case below as redundant with it.
  it("an unreadable author on the CARRIED-finding route keeps the red and still reports", async () => {
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => null,
        listReviewerSurfaces: async () => ({
          reviews: [],
          comments: [
            { login: ALLY, body: dirtyAtOld, createdAt: "2026-09-06T00:00:00Z" },
            { login: ALLY, body: clean, createdAt: "2026-09-06T01:00:00Z" },
          ],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(true);
    expect(r.diagnostics.some((d) => d.startsWith("github-truth-probe-failed:pr_author:"))).toBe(true);
  });

  // PRs are probed in PARALLEL, so the longest SERIAL chain — not the PR count
  // — is what has to fit the deadline. Two halves, because each rots
  // differently: the arithmetic catches a per-call budget raised past the
  // deadline, the call count catches a fifth call added to the chain. The
  // per-call signal cannot rescue an overflow: `abort()` runs in the `.finally()`
  // AFTER `Promise.race` has already resolved `"deadline"`, which discards the
  // results of every PR that had already finished.
  //
  // Pin the MARGIN, not the relation: `< PROBE_DEADLINE_MS` is satisfied by
  // `PER_CALL_TIMEOUT_MS = 1999` with 4ms of headroom, which defeats the very
  // thing the headroom is for — a cold `getInstallationToken()` sits OUTSIDE
  // the per-call signal, so a chain that only just fits has nowhere to put it.
  // 10% of the deadline is the 800ms the current values already leave.
  it("the longest serial call chain fits inside the whole-probe deadline, with headroom", () => {
    expect(MAX_SERIAL_CALLS * PER_CALL_TIMEOUT_MS).toBeLessThanOrEqual(PROBE_DEADLINE_MS * 0.9);
  });

  it("the would-be-clean route makes no more serial calls than MAX_SERIAL_CALLS", async () => {
    let calls = 0;
    const counted = <T,>(value: T) => async () => {
      calls += 1;
      return value;
    };
    const r = await buildGithubTruthProbe(
      deps({
        // `trust: null` forces the merge confirm call, so this is the full
        // chain: gate → head → surfaces → author.
        getPullRequestGate: counted({ state: "closed", merged: true } as const),
        fetchHeadSha: counted(HEAD),
        listReviewerSurfaces: counted({
          // Reviews surface: the subject is the serial-call BUDGET on the
          // would-be-clean route, and that route now needs a review
          // submission to reach `clean` (PEN-4431).
          reviews: [
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
          ],
          comments: [],
        }),
        fetchPrAuthorLogin: counted("some-human"),
      }),
    )({ workProducts: [wp({ merged: true, trust: null })] });
    expect(r.detections["review:ally-clean"]).toBe(true);
    expect(calls).toBe(MAX_SERIAL_CALLS);
  });

  it("a formal review at head with no blocking feedback is clean", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    );
    const r = await probe({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBe(true);
  });

  // BLO-34969, the falsifier this row was filed for. Before it, WHICH GitHub
  // object carried a body decided whether the self-attestation rule applied to
  // it: Surface 1 refused an author-written `clean` and Surface 2 published the
  // identical body off the identical row through the OR.
  //
  // Asserted as an EQUIVALENCE rather than as two literals on purpose. The
  // property is "the surface does not change the answer", so a future edit that
  // moves BOTH surfaces together stays green, and one that moves only one goes
  // red whichever direction it moves in.
  it("a self-attested clean body gives the SAME verdict on either surface", async () => {
    const row = { login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" };
    const onSurface = async (which: "reviews" | "comments") =>
      buildGithubTruthProbe(
        deps({
          // The PR author IS the attesting identity — an agent-authored PR.
          fetchPrAuthorLogin: async () => ALLY,
          listReviewerSurfaces: async () =>
            which === "reviews"
              ? {
                  reviews: [{ ...row, state: "COMMENTED", commitId: HEAD, submittedAt: row.createdAt }],
                  comments: [],
                }
              : { reviews: [], comments: [row] },
        }),
      )({ workProducts: [wp()] });

    const asReview = await onSurface("reviews");
    const asComment = await onSurface("comments");
    expect(asReview.detections["review:ally-clean"]).toBe(asComment.detections["review:ally-clean"]);
    // And the shared answer is the WITHHELD one. Equivalence alone would also
    // be satisfied by both surfaces crediting it, which is the defect.
    expect(asReview.detections["review:ally-clean"]).toBeUndefined();
    // Nothing failed: refusing to vouch is a verdict the probe reached, not an
    // inability to ask. A `probeFailed` here would suppress the escalation
    // branch and quietly restore the pass it just declined to give.
    expect(asReview.probeFailed).toBe(false);
    expect(asComment.probeFailed).toBe(false);
  });

  // The positive control that keeps the guard above a NARROWING rather than an
  // off switch, built on the population that is actually REACHABLE in
  // production (Ally review of #1966): the reviewer is the Ally App — every row
  // on that surface has passed `githubReviewerIdentityMatches`, so it can be
  // nothing else — and its body attests this head while failing Surface 1's
  // consolidated-review heading grammar. Surface 1 returns `not_evaluated`, so
  // `formalClean` is load-bearing here and deleting it instead of gating it
  // would have taken this with it.
  //
  // The earlier version of this control used `login: "some-human"`, which the
  // surface filter makes unreachable — a control over nothing. It also could
  // not show `formalClean` was load-bearing, because that body passes Surface
  // 1's grammar too.
  it("a formal Ally review whose body lacks the consolidated heading is still clean", async () => {
    const onSurface = (which: "reviews" | "comments") =>
      buildGithubTruthProbe(
        deps({
          // A PR opened by someone other than the reviewer identity.
          fetchPrAuthorLogin: async () => "some-human",
          listReviewerSurfaces: async () =>
            which === "reviews"
              ? {
                  reviews: [
                    {
                      login: ALLY,
                      body: attestedNoHeading,
                      state: "COMMENTED",
                      commitId: HEAD,
                      submittedAt: "2026-09-06T00:00:00Z",
                    },
                  ],
                  comments: [],
                }
              : { reviews: [], comments: [{ login: ALLY, body: attestedNoHeading, createdAt: "2026-09-06T00:00:00Z" }] },
        }),
      )({ workProducts: [wp()] });

    const asReview = await onSurface("reviews");
    expect(asReview.detections["review:ally-clean"]).toBe(true);
    expect(asReview.probeFailed).toBe(false);
    // And Surface 2 is genuinely the ONLY surface that reaches it, which is the
    // property the control rests on: give this body the `## Ally` heading and
    // the assertion above still passes while the control stops controlling
    // anything. That is the defect this test replaced, so it is pinned.
    //
    // NOT a counter-example to the surface-equivalence falsifier above. That
    // property is about the AUTHOR rule, which must never depend on the
    // surface. The GRAMMAR differs between surfaces by design — Surface 1
    // applies the full consolidated-review grammar, Surface 2 asks only for an
    // attestation — and the falsifier holds a body that passes both.
    expect((await onSurface("comments")).detections["review:ally-clean"]).toBeUndefined();
  });

  // The bare `<slug>` user seat and the `<slug>[bot]` App are one agent in two
  // hats, so a PR opened by one and attested by the other is still nothing
  // independent reading that head. `githubSharesReviewerIdentity` is
  // directional and cannot answer this; `githubSameActorLogin` exists for it.
  it("the reviewer bot attesting a PR opened by its own user seat is not clean", async () => {
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => "allyblockcast",
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(false);
  });

  // Fail CLOSED, and say so. An unread author cannot establish independence, so
  // the attestation is not credited — and `probeFailed` marks it as an
  // inability to ask rather than a fact about the work, which is what keeps a
  // GitHub blip from reading as "nobody reviewed this".
  it("an unreadable PR author withholds the formal clean and marks the probe failed", async () => {
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => null,
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(true);
    // ONE line per cause. This row reaches BOTH surfaces — Surface 1 through
    // the merged comment list, Surface 2 as a formal review — and both ask for
    // the author, so a per-caller push reported the identical string twice for
    // a single failed read. `.some()` cannot see that, and the runbook reads
    // these aggregated (Ally review of #1966).
    expect(r.diagnostics.filter((d) => d.startsWith("github-truth-probe-failed:pr_author:"))).toHaveLength(1);
  });

  // ...but ONLY while the author can still change the answer. Once Surface 1 is
  // already blocking, `formalClean` cannot reach the `out.clean` conjunction, so
  // the Surface 2 read buys nothing and an unreadable `GET /pulls/{n}` turns a
  // probe that HAS a red verdict into `probeFailed` — which `evidence-gate.ts`
  // reads as "could not ask", suppressing the `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK`
  // promotion and blaming the wrong cause in the runbook (Ally review of #1966).
  //
  // The reachable route is `blocking_finding`, which is author-blind by design
  // (`pr-comment-review-gate.ts`, "a finding is a finding whoever wrote it") so
  // Surface 1 never reads the author and Surface 2's read is a REAL extra call.
  // NOT the `authorUnknown`-carrying `carried_finding` sub-shape the review
  // named: `authorUnknown` rides that route only via `withheldPositive`, which
  // needs a `## Ally` body attesting this head — so Surface 1 has already read,
  // the memo makes Surface 2 free, and a guard written against it would survive
  // reverting the fix. The grammar-failing carried sub-shape DOES reach this
  // read (Ally review of #2143); it is not excluded, only the memoized one is.
  //
  // Two rows are load-bearing. Surface 2 keys `formalAttestingReview` off the
  // newest at-head REVIEW, so the blocking row has to be an issue COMMENT: one
  // row cannot be both blocking and attesting-clean.
  it("an already-blocking comment verdict suppresses the Surface 2 author read entirely", async () => {
    let authorCalls = 0;
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => {
          authorCalls += 1;
          return null;
        },
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
          ],
          comments: [{ login: ALLY, body: dirty, createdAt: "2026-09-06T01:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(authorCalls).toBe(0);
    expect(r.probeFailed).toBe(false);
    expect(r.diagnostics.filter((d) => d.startsWith("github-truth-probe-failed:pr_author:"))).toHaveLength(0);
    // And the red is untouched: suppressing the read must not soften the verdict.
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });

  // The SECOND reachable route, and the one that proves the exclusion in the
  // call-site comment is not a universal (Ally review of #2143). `carried_finding`
  // attaches `authorUnknown` only through `withheldPositive`, which needs a body
  // passing `isAllyConsolidatedReviewComment` at this head — so a body that
  // attests the head WITHOUT the `## Ally` heading carries no `authorUnknown`,
  // Surface 1 never reads, and the carry arrives here author-blind exactly like
  // `blocking_finding`. Measured on revert: `authorCalls` 0 -> 1 and
  // `probeFailed` false -> true, so this is discriminating and not a duplicate
  // of the case above — the two differ in WHICH surface supplies the red.
  it("an author-blind CARRIED finding also suppresses the Surface 2 read", async () => {
    let authorCalls = 0;
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => {
          authorCalls += 1;
          return null;
        },
        listReviewerSurfaces: async () => ({
          // Attests this head, so `formalAttestingReview` is defined — but fails
          // Surface 1's grammar, so it cannot disposition the older finding.
          reviews: [
            { login: ALLY, body: attestedNoHeading, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" },
          ],
          comments: [{ login: ALLY, body: dirtyAtOld, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(authorCalls).toBe(0);
    expect(r.probeFailed).toBe(false);
    expect(r.diagnostics.filter((d) => d.startsWith("github-truth-probe-failed:pr_author:"))).toHaveLength(0);
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });

  // Both surfaces now want the author, and the read is memoized so the pinned
  // MAX_SERIAL_CALLS relation to PROBE_DEADLINE_MS still holds. This drives the
  // path where BOTH ask: Surface 1 refuses the self-attestation, Surface 2 then
  // asks the same question of the same row.
  it("the PR author is read at most once even when both surfaces ask", async () => {
    let authorReads = 0;
    await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => {
          authorReads += 1;
          return ALLY;
        },
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(authorReads).toBe(1);
  });

  it("a formal review at head with Important(1), or CHANGES_REQUESTED, is not clean", async () => {
    const a = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: dirty, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(a.detections["review:ally-clean"]).toBeUndefined();

    const b = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: "fine", state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(b.detections["review:ally-clean"]).toBeUndefined();
  });

  it("only the NEWEST review at head decides: a later clean one supersedes an earlier finding", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: dirty, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" },
          ],
          comments: [],
        }),
      }),
    );
    expect((await probe({ workProducts: [wp()] })).detections["review:ally-clean"]).toBe(true);
  });

  // A COHERENT review of another head: `commit_id` and the body attestation
  // agree. The incoherent variant — `commit_id` at D while the body attests
  // HEAD — is the NEXT case, and it is the one GitHub actually produces, by
  // rewriting `commit_id` on push.
  it("a review at a DIFFERENT head is not evidence about this head", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            {
              login: ALLY,
              body: clean.replace(HEAD, "d".repeat(40)),
              state: "COMMENTED",
              commitId: "d".repeat(40),
              submittedAt: "2026-09-06T00:00:00Z",
            },
          ],
          comments: [],
        }),
      }),
    );
    expect((await probe({ workProducts: [wp()] })).detections["review:ally-clean"]).toBeUndefined();
  });

  // GitHub REWRITES `commit_id` when the branch is updated, so this shape is
  // not hypothetical: it is what every review of a superseded tree looks like
  // after a push. The body attestation is immutable and is the only field that
  // says which tree was actually read.
  it("a review whose commit_id was rewritten onto this head, but whose body attests another, is not clean", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: clean.replace(HEAD, "d".repeat(40)), state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
          ],
          comments: [],
        }),
      }),
    );
    expect((await probe({ workProducts: [wp()] })).detections["review:ally-clean"]).toBeUndefined();
  });

  // Dismissal is an authorized actor withdrawing a verdict from operation, so
  // it is dropped in BOTH directions — the same ruling
  // `githubListPrReviewsWithTimestamps` already makes for the merge gate.
  it("a DISMISSED clean review at head is not evidence — a retraction is not an approval", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "DISMISSED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    );
    expect((await probe({ workProducts: [wp()] })).detections["review:ally-clean"]).toBeUndefined();
  });

  it("a DISMISSED review does not veto a live clean one, and does not win by being newest", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
            // Newer AND blocking: without the filter this would both win the
            // sort and wedge the shape off a verdict nobody stands behind.
            { login: ALLY, body: dirty, state: "DISMISSED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" },
          ],
          comments: [],
        }),
      }),
    );
    expect((await probe({ workProducts: [wp()] })).detections["review:ally-clean"]).toBe(true);
  });

  it("a comment attested at a stale head reaches not_evaluated — not detected, and not a failure", async () => {
    const r = await buildGithubTruthProbe(deps({ fetchHeadSha: async () => "d".repeat(40) }))({
      workProducts: [wp()],
    });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    // "Nobody reviewed this head" is a real, established answer. Only an
    // inability to ASK is a probe failure.
    expect(r.probeFailed).toBe(false);
  });

  it("head fetch returning null is a probe failure with a named diagnostic", async () => {
    const r = await buildGithubTruthProbe(deps({ fetchHeadSha: async () => null }))({ workProducts: [wp()] });
    expect(r.probeFailed).toBe(true);
    expect(r.diagnostics).toContain("github-truth-probe-failed:head_sha:Blockcast/paperclip#1588");
  });

  it("a surfaces error or a gate error is a probe failure", async () => {
    const a = await buildGithubTruthProbe(deps({ listReviewerSurfaces: async () => ({ error: "reviews_fetch_failed" }) }))({
      workProducts: [wp()],
    });
    expect(a.probeFailed).toBe(true);
    expect(a.diagnostics).toContain("github-truth-probe-failed:surfaces:Blockcast/paperclip#1588:reviews_fetch_failed");

    const b = await buildGithubTruthProbe(
      deps({ getPullRequestGate: async () => ({ error: "pull_request_fetch_failed" }) }),
    )({ workProducts: [wp()] });
    expect(b.probeFailed).toBe(true);
    expect(b.diagnostics).toContain(
      "github-truth-probe-failed:pull_request:Blockcast/paperclip#1588:pull_request_fetch_failed",
    );
  });

  it("two PRs: every one must be merged, and every one must be clean", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        getPullRequestGate: async (ref) => ({
          state: ref.prNumber === 1588 ? "closed" : "open",
          merged: ref.prNumber === 1588,
        }),
      }),
    );
    const r = await probe({ workProducts: [wp(), wp({ prNumber: 1585 })] });
    expect(r.detections["deploy:landed"]).toBeUndefined();
    expect(r.detections["review:ally-clean"]).toBe(true);
  });

  it("two PRs: one dirty review makes the whole set dirty", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async (ref) => ({
          reviews: [],
          comments: [
            {
              login: ALLY,
              body: ref.prNumber === 1588 ? clean : dirty,
              createdAt: "2026-09-06T00:00:00Z",
            },
          ],
        }),
      }),
    );
    const r = await probe({ workProducts: [wp({ merged: true }), wp({ prNumber: 1585, merged: true })] });
    expect(r.detections["deploy:landed"]).toBe(true);
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(false);
  });

  it("no linked PR → no detections, a diagnostic, and NOT a probe failure", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: [] });
    // `noLinkedPullRequest` is the load-bearing half: it is what lets the gate
    // suppress the escalation WITHOUT claiming the probe failed. Asserting the
    // whole object keeps the two states from silently collapsing again — now
    // three states, with `reviewerAuthoredPr` false here because there is no
    // PR to have an author (PEN-4265).
    expect(r).toEqual({
      detections: {},
      diagnostics: ["no-linked-pull-request"],
      probeFailed: false,
      noLinkedPullRequest: true,
      reviewerAuthoredPr: false,
    });
  });

  // PEN-4265. The App-authored population: the review happened, attests this
  // exact head and reports nothing blocking, and the ONLY thing unestablished
  // is its independence from the author. The probe has to say so in its own
  // field, because `review:ally-clean` being absent is the same observation
  // for this and for "nobody reviewed it" — and only one of the two is
  // reachable by the assignee.
  it("reviewer identity authored the PR → clean withheld, and reviewerAuthoredPr names why", async () => {
    const r = await buildGithubTruthProbe(deps({ fetchPrAuthorLogin: async () => ALLY }))({
      workProducts: [wp()],
    });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.reviewerAuthoredPr).toBe(true);
    // Not an outage and not a PR-less issue. Each of the three drives a
    // different operator-visible suppression reason.
    expect(r.probeFailed).toBe(false);
    expect(r.noLinkedPullRequest).toBe(false);
  });

  // The positive control for the field, and the one that keeps it from being
  // true-by-default: the SAME fixture with an independent author reaches
  // `clean`, so the flag is reporting the author and not the absence of a
  // review.
  it("independent author on the same fixture → clean detected and reviewerAuthoredPr false", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBe(true);
    expect(r.reviewerAuthoredPr).toBe(false);
  });

  // `every`, mirroring the `every` that decides `clean`. One PR in the set
  // with a gap the assignee CAN close makes the set actionable, so the
  // identity claim must not be made for it. Without this the suppression
  // would hide a real unreviewed PR behind a sibling's author.
  it("one identity-blocked PR beside one nobody attested → reviewerAuthoredPr false", async () => {
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => ALLY,
        // #1588 carries the at-head attestation; #1585's newest comment
        // attests an older head, so nothing attests its current one.
        listReviewerSurfaces: async ({ prNumber }) => ({
          reviews: [],
          comments:
            prNumber === 1588
              ? [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }]
              : [],
        }),
      }),
    )({ workProducts: [wp(), wp({ prNumber: 1585 })] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.reviewerAuthoredPr).toBe(false);
  });

  // SINGLE-PR mixed case. Found by Ally's review of #2810 and it was a
  // fail-open: `out.clean` is false for four independent reasons and only the
  // comment-surface ones are visible to the marker, so a self-attested at-head
  // comment beside a BLOCKING FORMAL REVIEW used to yield
  // `clean: false, authorIsReviewer: true` — suppressing the escalation on a
  // head that carries an actionable finding, with a diagnostic claiming only
  // independence was missing. The set-level test above cannot reach this: it
  // needs both conditions on ONE PR.
  it("self-attested comment beside a BLOCKING formal review → reviewerAuthoredPr false", async () => {
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => ALLY,
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: dirty, state: "COMMENTED", commitId: HEAD, submittedAt: null }],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.reviewerAuthoredPr).toBe(false);
  });

  // The other formal veto, same shape. A `tracked` entry is a reviewer
  // accepting a real defect onto a follow-up — an actionable residual, not an
  // identity problem.
  it("self-attested comment beside a DEFERRING formal review → reviewerAuthoredPr false", async () => {
    const tracked = clean.replace(
      "### Recommended Action",
      "### Prior Findings Dispositioned (1)\n- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.\n\n### Recommended Action",
    );
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => ALLY,
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: tracked, state: "COMMENTED", commitId: HEAD, submittedAt: null }],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.reviewerAuthoredPr).toBe(false);
  });

  // The COMMENT-surface asymmetry, also from that review. For a self-authored
  // PR the gate takes the withheld-positive branch and never ran the deferral
  // check on the attesting body — that check lives only in the independent
  // branch — so a body accepting a residual still read as identity-only, while
  // the SAME body under an independent author yields `deferred_finding` and is
  // vetoed. The asymmetry failed open, and in the author's favour.
  it("self-attested comment that itself DEFERS a finding → reviewerAuthoredPr false", async () => {
    const trackedSelf = clean.replace(
      "### Recommended Action",
      "### Prior Findings Dispositioned (1)\n- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.\n\n### Recommended Action",
    );
    const r = await buildGithubTruthProbe(
      deps({
        fetchPrAuthorLogin: async () => ALLY,
        listReviewerSurfaces: async () => ({
          reviews: [],
          comments: [{ login: ALLY, body: trackedSelf, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.reviewerAuthoredPr).toBe(false);
  });

  // Same withholding the detections get, for the same reason: a PR that was
  // never read could be the one carrying the real gap, so the five that are
  // identity-blocked say nothing about the set.
  it("a capped read withholds reviewerAuthoredPr too", async () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => wp({ prNumber: n }));
    const r = await buildGithubTruthProbe(deps({ fetchPrAuthorLogin: async () => ALLY }))({
      workProducts: many,
    });
    expect(r.reviewerAuthoredPr).toBe(false);
  });

  it("more than 5 linked PRs → probes the 5 highest, names the rest, and withholds every detection", async () => {
    const many = [1, 2, 3, 4, 5, 6].map((n) => wp({ prNumber: n, merged: true }));
    const r = await buildGithubTruthProbe(deps())({ workProducts: many });
    expect(r.diagnostics).toContain("too-many-linked-prs:6:skipped=Blockcast/paperclip#1");
    // An unread PR could be the unmerged one, so a capped read cannot claim
    // the whole set landed. All six here ARE merged, so without the cap guard
    // the surviving five would set `deploy:landed` and read as a full landing —
    // `probeFailed` does not stop that, because it never reaches the `pass` path.
    expect(r.detections).toEqual({});
    expect(r.probeFailed).toBe(true);
  });

  // Mirrors the blocking veto: a deferral on one surface must not be laundered
  // into `review:ally-clean` by a clean verdict on the other.
  it("a tracked deferral on either surface beats a clean one on the other", async () => {
    const tracked = clean.replace(
      "### Recommended Action",
      "### Prior Findings Dispositioned (1)\n- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.\n\n### Recommended Action",
    );
    // Comment surface deferred, formal surface clean at the same head.
    //
    // Both rows carry a real `submittedAt`, so the review is actually spread
    // into the gate's merged comment list. With `submittedAt: null` the review
    // was dropped at the filter in `evidence-truth.ts` and this case degraded
    // to a single-comment fixture that never exercised the cross-surface
    // ordering it names (Ally, #2875 at 79949bbe). The review is the OLDER of
    // the two, which is the direction that matters: a newer deferral must
    // still veto an older clean vouch.
    const a = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-05T00:00:00Z" },
          ],
          comments: [{ login: ALLY, body: tracked, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(a.detections["review:ally-clean"]).toBeUndefined();
    expect(a.probeFailed).toBe(false);

    // And the mirror: formal review deferred, comment clean.
    const b = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            { login: ALLY, body: tracked, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-05T00:00:00Z" },
          ],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(b.detections["review:ally-clean"]).toBeUndefined();
  });

  it("a blocking verdict on either surface beats a clean one on the other", async () => {
    // Comment surface red, formal surface clean at the same head. The merge
    // gate publishes from the comment surface, so reading this clean would put
    // the two gates in opposite states on one head. The red is the NEWER of
    // the two: with the clean later, it would legitimately supersede the
    // finding on the merged surface and this would stop testing the veto.
    const a = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-05T23:00:00Z" }],
          comments: [{ login: ALLY, body: dirty, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(a.detections["review:ally-clean"]).toBeUndefined();
    expect(a.probeFailed).toBe(false);

    // And the mirror: formal review red, comment clean.
    const b = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: "nope", state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" }],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(b.detections["review:ally-clean"]).toBeUndefined();

    // And the BODY arm of the same veto, isolated. Case `b` above reddens
    // through `hasActionablePrReviewFeedback`'s STATE arm, and case `a` of the
    // Important(1) test reddens on BOTH surfaces at once now that the fixtures
    // carry `submittedAt` — so neither one fails if the body arm is reverted.
    // A body with no `## Ally` heading is invisible to the comment gate
    // (`isAllyConsolidatedReviewComment`), so the clean comment decides Surface
    // 1 and only `carriesBlockingFeedback` can hold the detection back.
    const c = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            {
              login: ALLY,
              body: "### Important Issues (1)\n- The formal surface must redden on the body, not only on the state.",
              state: "COMMENTED",
              commitId: HEAD,
              submittedAt: "2026-09-06T01:00:00Z",
            },
          ],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(c.detections["review:ally-clean"]).toBeUndefined();
    expect(c.probeFailed).toBe(false);
  });

  it("exceeding the deadline fails the probe rather than returning a partial answer", async () => {
    const slow = deps({ fetchHeadSha: () => new Promise((res) => setTimeout(() => res(HEAD), 200)) });
    const r = await buildGithubTruthProbe(slow, { deadlineMs: 50, perCallMs: 20 })({ workProducts: [wp()] });
    expect(r.probeFailed).toBe(true);
    expect(r.diagnostics).toContain("truth-probe-deadline");
    expect(r.detections).toEqual({});
  });

  it("the deadline cancels the reads still in flight", async () => {
    let observed: AbortSignal | undefined;
    const slow = deps({
      fetchHeadSha: (ref) =>
        new Promise((res) => {
          observed = ref.signal;
          setTimeout(() => res(HEAD), 500);
        }),
    });
    // perCallMs far beyond the deadline, so an abort here can only have come
    // from the probe-wide controller.
    const r = await buildGithubTruthProbe(slow, { deadlineMs: 50, perCallMs: 60_000 })({ workProducts: [wp()] });
    expect(r.diagnostics).toContain("truth-probe-deadline");
    expect(observed?.aborted).toBe(true);
  });

  it("a dep that throws is a probe failure, not an unhandled rejection", async () => {
    const r = await buildGithubTruthProbe(
      deps({
        fetchHeadSha: async () => {
          throw new Error("socket hang up");
        },
      }),
    )({ workProducts: [wp()] });
    expect(r.probeFailed).toBe(true);
    expect(r.detections["review:ally-clean"]).toBeUndefined();
  });

  // A `tracked` deferral on a formal review must not read as clean.
  //
  // This row does NOT isolate the formal surface, and saying so is the point:
  // `submittedAt` is a string, so the review is also spread into
  // `commentInput.comments`, and `clean` carries the `## Ally` heading — so
  // Surface 1 parses it, returns `deferred_finding`, and `commentDeferred`
  // alone satisfies the assertion. Deleting `formalDeferred` from the veto
  // leaves this green. It is kept as the realistic end-to-end shape; the row
  // below is the one that pins the formal half.
  //
  // The default fixture author is `some-human`, i.e. INDEPENDENT, and that is
  // load-bearing here: the BLO-34969 independence gate would withhold this
  // detection on its own for a self-attested body, so a self-attested fixture
  // would make this row pass whether or not the deferral is honored. The
  // deferral must be the only reason the detection is absent.
  it("a formal 0/0 review at head carrying a tracked deferral is not clean", async () => {
    const tracked = clean.replace(
      "### Recommended Action",
      "### Prior Findings Dispositioned (1)\n- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.\n\n### Recommended Action",
    );
    const r = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: tracked, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" }],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(false);
  });

  // The failing mutation for the cross-surface deferral veto, on a
  // PRODUCTION-REACHABLE shape (Ally review of #2076, head 0394d75b0).
  //
  // The veto's only other failing mutation lives on a `submittedAt: null`
  // review — a divergence `evidence-truth.ts` itself calls something "GitHub
  // does not produce for a submitted review". Per BLO-34263 a guard needs a
  // mutation that fails for the reason the guard EXISTS, so a guard whose sole
  // witness is an acknowledged-unreachable shape is not covered.
  //
  // This is the negative twin of the `attestedNoHeading` positive control
  // above, and it reuses it on purpose: a body with a `Reviewed head:` marker
  // and NO `## Ally` heading is the exact population that comment names as
  // what `formalClean` still buys. Surface 1 skips it on grammar
  // (`isAllyConsolidatedReviewComment` requires the heading) and returns
  // `not_evaluated` with no `authorUnknown`, so `commentDeferred` is false and
  // cannot carry this assertion. Surface 2 is the only surface that reaches
  // it, the author is distinct so `formalClean` is genuinely true, and
  // `formalDeferred` is the one thing standing between that and a published
  // `review:ally-clean` on a head with a live accepted residual.
  //
  // MUTATION: drop `!formalDeferred` from the `out.clean` veto and this flips
  // to `true`.
  it("a tracked deferral vetoes a clean the formal surface alone can see", async () => {
    const trackedNoHeading = `${attestedNoHeading}

### Prior Findings Dispositioned (1)
- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.`;
    const r = await buildGithubTruthProbe(
      deps({
        // A PR opened by someone other than the reviewer identity, so the
        // BLO-34969 independence gate is satisfied and the deferral is the
        // only reason the detection can be absent.
        fetchPrAuthorLogin: async () => "some-human",
        listReviewerSurfaces: async () => ({
          reviews: [
            {
              login: ALLY,
              body: trackedNoHeading,
              state: "COMMENTED",
              commitId: HEAD,
              submittedAt: "2026-09-06T00:00:00Z",
            },
          ],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    // The author read succeeded, so the absence is the veto and not a failed
    // probe — without this the row would also pass on an unreadable author.
    expect(r.probeFailed).toBe(false);
  });

  // BLO-38032. `commit_id` is mutable and GitHub re-anchors it FORWARD onto the
  // new head on a branch update (BLO-27234, n=128), so `atHead` admits a review
  // of a tree that no longer exists. `formalDeferred` read that row's ledger and
  // vetoed, killing a genuine clean this head's own reviewer published.
  //
  // MUTATION: restore the `attested !== normalizedHead` arm's absence —
  // i.e. key `formalDeferred` on `newest` alone — and this row goes red.
  it("a tracked deferral attesting a REPLACED head does not veto this head's clean", async () => {
    const trackedAtOld = `## Ally — Consolidated PR Review
**Reviewed head:** \`${OLD}\`

### Critical Issues (0)
None.

### Important Issues (0)
None.

### Prior Findings Dispositioned (1)
- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.

### Recommended Action
Land.`;
    // Built literally rather than by chaining `.replace` off `clean`:
    // `.replace(String, ...)` substitutes only the FIRST occurrence, so a
    // fixture assembled that way can silently keep attesting HEAD and pass for
    // the wrong reason.
    expect(trackedAtOld).toContain(OLD);
    expect(trackedAtOld).not.toContain(HEAD);

    const r = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          // Both rows on the reviews surface. `submittedAt` is a real
          // timestamp on each, so both are spread into the gate's comment list
          // — the production-reachable shape, not the `submittedAt: null`
          // divergence. The tracked row attests OLD, so it is not `forHead`
          // and cannot set `commentDeferred`; the clean row at HEAD is, and it
          // has to be a review submission to reach `clean` (PEN-4431).
          reviews: [
            { login: ALLY, body: trackedAtOld, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
            { login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" },
          ],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeDefined();
    expect(r.probeFailed).toBe(false);
  });

  // The other half of that narrowing, and the reason it is a narrowing rather
  // than a swap to `=== normalizedHead`: an UNATTESTED body still vetoes.
  //
  // This is not hypothetical bookkeeping. `countAllyDeferredPriorFindings`
  // reads the RAW body while `extractAllyReviewedHeadSha` reads the
  // fence-stripped one, so an unbalanced fence can blank the attestation while
  // the ledger survives. Requiring a positive match would hand that shape a
  // `review:ally-clean` on a head with a live accepted residual — the exact
  // BLO-36903 misstatement the veto exists to prevent, reintroduced by the fix
  // for BLO-38032.
  //
  // MUTATION: drop the `attested !== null` arm (require `=== normalizedHead`)
  // and this row goes red.
  it("a tracked deferral that attests NO head still vetoes", async () => {
    const trackedNoAttestation = `Looks fine to me.

### Prior Findings Dispositioned (1)
- **prior:abcdef0 important 1** - tracked - accepted onto BLO-36822.`;
    expect(extractAllyReviewedHeadSha(trackedNoAttestation)).toBeNull();

    const r = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [
            {
              login: ALLY,
              body: trackedNoAttestation,
              state: "COMMENTED",
              commitId: HEAD,
              submittedAt: "2026-09-06T00:00:00Z",
            },
          ],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T01:00:00Z" }],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(false);
  });
});

/**
 * The probe's half of the author-lane read (BLO-43550).
 *
 * The gate's orchestration is covered in
 * `server/src/__tests__/pr-comment-review-gate-check.test.ts`; this suite covers
 * the MIRROR in `probeOne`, which reads the same lane for the same reason over a
 * different dependency surface. It exists because that mirror shipped with no
 * behavioural case and a fail-closed guard that did not fail closed (Ally review
 * of #2498): per this repo's standard, a guard with no failing mutation is a
 * comment.
 *
 * ⚠ `reviewer` is a SELF-DECLARATION, not a trust boundary. These cases pin that
 * the probe refuses a retirement declaring the head commit author's own lane —
 * not that an author cannot retire its own finding, which it still can by
 * omitting the field.
 */
describe("buildGithubTruthProbe — author-lane mirror (BLO-43550)", () => {
  const AUTHOR_LANE = "staff-engineer@paperclip.blockcast.net";
  const OTHER_LANE = "ally@paperclip.blockcast.net";
  // A head BETWEEN the finding and the current one. The retirement has to attest
  // something OTHER than the current head, or `forHead` short-circuits to the
  // `clean` return above the carried-finding check and the lane is never
  // consulted — the same reason the gate suite uses an intermediate head.
  const MID = "b".repeat(40);

  const verdictBlock = (head: string, lane: string | null, dispositions: unknown[]): string =>
    [
      "<!-- ally-verdict:1",
      JSON.stringify({
        head,
        findings: { critical: 0, important: 0 },
        dispositions,
        ...(lane === null ? {} : { reviewer: lane }),
      }),
      "-->",
    ].join("\n");

  /** Ally retiring OLD's Important at MID, optionally declaring its own lane. */
  const retiringAtMid = (lane: string | null): string =>
    [
      "## Ally — Consolidated PR Review",
      "",
      verdictBlock(MID, lane, [{ head: OLD.slice(0, 7), severity: "important", index: 1, verb: "fixed" }]),
      "",
      `Reviewed head: ${MID}`,
      "### Prior Findings Dispositioned (1)",
      `- **prior:${OLD.slice(0, 7)} important 1** — fixed — re-checked against this head.`,
      "### Critical Issues (0)",
      "### Important Issues (0)",
    ].join("\n");

  // A finding raised at OLD and retired at MID, beside a formal review object
  // that attests the CURRENT head but carries no `## Ally` heading. That review
  // is the Surface-2-only population `formalClean` exists for, and it is what
  // makes the lane load-bearing here: credit the retirement and Surface 2
  // vouches, refuse it and `commentBlocking` vetoes.
  // The retiring body is a review SUBMISSION. PEN-4431 refuses a retirement
  // carried as a plain issue comment, so leaving it on the comment surface
  // would red both arms of this pair for a surface reason and destroy the
  // lane as the single variable these two cases turn on. The dirty body stays
  // on the comment surface deliberately: RAISING is surface-blind, and keeping
  // it there proves that.
  const corpus = (lane: string | null) => async () => ({
    reviews: [
      { login: ALLY, body: attestedNoHeading, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T02:00:00Z" },
      { login: ALLY, body: retiringAtMid(lane), state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T01:00:00Z" },
    ],
    comments: [{ login: ALLY, body: dirtyAtOld, createdAt: "2026-09-06T00:00:00Z" }],
  });

  it("refuses a retirement declaring the head commit author's own lane, and does not vouch", async () => {
    const r = await buildGithubTruthProbe(
      deps({ listReviewerSurfaces: corpus(AUTHOR_LANE), fetchCommitAuthorEmail: async () => AUTHOR_LANE }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    // Refusing a retirement is a VERDICT, not an inability to ask.
    expect(r.probeFailed).toBe(false);
  });

  // THE NEGATIVE CONTROL: byte-identical but for the declared lane. Both sides
  // carry the same single `allyblockcast[bot]` login, which is why this can
  // never be a login comparison.
  it("still credits the retirement when the review declares a different lane", async () => {
    const r = await buildGithubTruthProbe(
      deps({ listReviewerSurfaces: corpus(OTHER_LANE), fetchCommitAuthorEmail: async () => AUTHOR_LANE }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBe(true);
    expect(r.probeFailed).toBe(false);
  });

  // THE FAIL-CLOSED GUARD. A null lane CREDITS the retirement — the gate's own
  // anti-deadlock direction — so on this corpus an unread lane left this probe
  // vouching `clean` at a head the gate, reading the lane, publishes `failure`
  // for. `failed` alone does not withhold the vouch: `out.clean` never reads it,
  // the aggregator treats it as suppressing the escalation branch and not the
  // pass path, and `evidence-gate` reads it as "could not ask" and DEMOTES an
  // unlabeled block on the strength of it. So the guard has to return.
  //
  // MUTATION: drop the `return out` and only this row goes red — the control
  // above still passes, because its lane reads fine. Drop `out.failed = true`,
  // or the diagnostic push, and the second and third assertions catch those
  // separately.
  it("withholds the vouch — not merely `failed` — when a declared lane cannot be read", async () => {
    const r = await buildGithubTruthProbe(
      deps({ listReviewerSurfaces: corpus(AUTHOR_LANE), fetchCommitAuthorEmail: async () => null }),
    )({ workProducts: [wp()] });
    expect(r.detections["review:ally-clean"]).toBeUndefined();
    expect(r.probeFailed).toBe(true);
    expect(r.diagnostics.some((d) => d.startsWith("github-truth-probe-failed:commit_author_lane:"))).toBe(true);
  });

  // THE ZERO-EXTRA-CALLS AC on this side too: gated on a DECLARED lane, not on
  // the verdict outcome, so it stays free until a producer emits `reviewer`.
  // MUTATION: an unconditional fetch fails here and only here.
  it("issues no commit fetch when no comment declares a lane", async () => {
    let calls = 0;
    const r = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: corpus(null),
        fetchCommitAuthorEmail: async () => {
          calls += 1;
          return AUTHOR_LANE;
        },
      }),
    )({ workProducts: [wp()] });
    expect(calls).toBe(0);
    expect(r.probeFailed).toBe(false);
  });

  // The lane and the PR author are resolved TOGETHER. Serialized they would make
  // the would-be-clean route gate -> head -> surfaces -> lane -> author, a FIFTH
  // serial call, and `MAX_SERIAL_CALLS` is pinned strictly against
  // `PROBE_DEADLINE_MS` at exactly the boundary. So the concurrency is the
  // argument, and until now it was only a comment.
  //
  // This fixture needs BOTH fetches to be reached, which means a consolidated
  // comment attesting the current head (that is what sets `authorUnknown`) which
  // ALSO declares a lane.
  //
  // MUTATION: replace the `Promise.all` with two serial `await`s and
  // `maxInFlight` drops to 1.
  it("resolves the lane and the PR author concurrently, keeping the serial chain at 4", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const overlap = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return value;
    };
    const cleanDeclaring = clean.replace(
      "## Ally — Consolidated PR Review\n",
      `## Ally — Consolidated PR Review\n\n${verdictBlock(HEAD, OTHER_LANE, [])}\n`,
    );
    const r = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          // Reviews surface: this case asserts the CONCURRENCY of the lane and
          // author fetches on the would-be-clean route, which needs a review
          // submission to stay would-be-clean (PEN-4431).
          reviews: [
            { login: ALLY, body: cleanDeclaring, state: "COMMENTED", commitId: HEAD, submittedAt: "2026-09-06T00:00:00Z" },
          ],
          comments: [],
        }),
        fetchCommitAuthorEmail: () => overlap(AUTHOR_LANE),
        fetchPrAuthorLogin: () => overlap("some-human"),
      }),
    )({ workProducts: [wp()] });
    expect(maxInFlight).toBe(2);
    expect(MAX_SERIAL_CALLS).toBe(4);
    // A sanity check that the fixture reached the branch at all rather than
    // skipping it: an unrelated declared lane leaves the clean verdict standing.
    expect(r.detections["review:ally-clean"]).toBe(true);
  });
});
