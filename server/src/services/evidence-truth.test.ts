import { describe, expect, it } from "vitest";
import {
  buildGithubTruthProbe,
  prRefsFromWorkProducts,
  type GithubTruthDeps,
  type TruthWorkProduct,
} from "./evidence-truth.js";

const HEAD = "c".repeat(40);
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

  it("not merged per the webhook but merged on GitHub → detected via the confirm call", async () => {
    const r = await buildGithubTruthProbe(deps())({ workProducts: [wp()] });
    expect(r.detections["deploy:landed"]).toBe(true);
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

  it("a formal review at head with Important(1), or CHANGES_REQUESTED, is not clean", async () => {
    const a = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: dirty, state: "COMMENTED", commitId: HEAD, submittedAt: null }],
          comments: [],
        }),
      }),
    )({ workProducts: [wp()] });
    expect(a.detections["review:ally-clean"]).toBeUndefined();

    const b = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: "fine", state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: null }],
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

  it("a review at a DIFFERENT head is not evidence about this head", async () => {
    const probe = buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: "d".repeat(40), submittedAt: null }],
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
    // the two gates in opposite states on one head.
    const a = await buildGithubTruthProbe(
      deps({
        listReviewerSurfaces: async () => ({
          reviews: [{ login: ALLY, body: clean, state: "COMMENTED", commitId: HEAD, submittedAt: null }],
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
          reviews: [{ login: ALLY, body: "nope", state: "CHANGES_REQUESTED", commitId: HEAD, submittedAt: null }],
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
