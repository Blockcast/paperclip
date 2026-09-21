import { describe, expect, it } from "vitest";
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
    listReviewerSurfaces: async () => ({
      reviews: [],
      comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
    }),
    getPullRequestGate: async () => ({ state: "closed", merged: true }),
    // A PR opened by someone OTHER than the reviewer identity: the default
    // fixture is an independently-reviewed PR, so the comment surface can
    // still reach `clean`. Tests that want the self-attested shape override it.
    fetchPrAuthorLogin: async () => "some-human",
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
  it("the longest serial call chain fits inside the whole-probe deadline", () => {
    expect(MAX_SERIAL_CALLS * PER_CALL_TIMEOUT_MS).toBeLessThan(PROBE_DEADLINE_MS);
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
          reviews: [],
          comments: [{ login: ALLY, body: clean, createdAt: "2026-09-06T00:00:00Z" }],
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
    // whole object keeps the two states from silently collapsing again.
    expect(r).toEqual({
      detections: {},
      diagnostics: ["no-linked-pull-request"],
      probeFailed: false,
      noLinkedPullRequest: true,
    });
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
});
