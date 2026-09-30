/**
 * BLO-32198 — the deterministic half of "at most one operative Ally App review
 * per (PR, head SHA)".
 *
 * The invariant itself is enforced after the fact by
 * `scripts/check-ally-review-consistency.mjs` (I1), but a COMMENTED review
 * cannot be retracted through any GitHub API, so an after-the-fact guard can
 * only report the damage. These tests pin the predicate that prevents it.
 *
 * The negative cases carry the weight here. Suppressing a wake is destructive
 * in a way posting a redundant review is not — nothing retries a wake that was
 * never queued — so most of what follows pins what must NOT be treated as an
 * attestation.
 */
import { describe, expect, it } from "vitest";
import { allyReviewAlreadyAttestsHead } from "../services/pr-review-head-attestation.js";

const HEAD = "a47d93f3aa1c4f2b8e5d6c7a9b0e1f2a3c4d5e6f";
const OTHER_HEAD = "488b473f11223344556677889900aabbccddeeff";
// Shares a 12-char prefix with HEAD and differs only after it. Abbreviated
// SHAs collide in exactly this shape, so any prefix/startsWith comparison
// would call this the same commit and suppress review of a tree nobody read.
const PREFIX_TWIN = "a47d93f3aa1c0000000000000000000000000000";
const APP = "allyblockcast[bot]";

function reviewBody(sha: string) {
  return [
    "## Ally — Consolidated PR Review",
    "",
    `Reviewed head: ${sha}`,
    "",
    "### Critical Issues (0)",
  ].join("\n");
}

function listing(reviews: Array<{ login: string | null; body: string }>) {
  return async () => reviews.map((r) => ({ ...r, createdAt: "2026-09-05T00:00:00Z" }));
}

async function check(
  listPrReviews: Parameters<typeof allyReviewAlreadyAttestsHead>[0]["listPrReviews"],
  headSha = HEAD,
) {
  return allyReviewAlreadyAttestsHead({
    repoFullName: "Blockcast/paperclip",
    prNumber: 1316,
    headSha,
    botLogin: APP,
    listPrReviews,
  });
}

describe("allyReviewAlreadyAttestsHead", () => {
  it("reports an App review whose body attests this exact head", async () => {
    const result = await check(listing([{ login: APP, body: reviewBody(HEAD) }]));
    expect(result).toEqual({ outcome: "attested", attestingReviewCount: 1 });
  });

  it("counts every attesting review, so an existing duplicate is still visible", async () => {
    const result = await check(
      listing([
        { login: APP, body: reviewBody(HEAD) },
        { login: APP, body: `${reviewBody(HEAD)}\n\nSecond pass.` },
      ]),
    );
    expect(result).toEqual({ outcome: "attested", attestingReviewCount: 2 });
  });

  it("does not treat a review of a DIFFERENT head as attesting this one", async () => {
    // The whole failure mode this guards: suppressing review of a head nobody
    // read. `commit_id` would say otherwise after a branch update; the body
    // does not move.
    const result = await check(listing([{ login: APP, body: reviewBody(OTHER_HEAD) }]));
    expect(result).toEqual({ outcome: "not_attested" });
  });

  it("requires the full sha, not a shared prefix", async () => {
    // Guards against comparing by startsWith/slice: PREFIX_TWIN agrees with
    // HEAD for 12 characters. Treating that as a match would suppress the
    // reviewer on a head that was never examined, which is the one direction
    // this predicate must never fail in.
    const result = await check(listing([{ login: APP, body: reviewBody(PREFIX_TWIN) }]));
    expect(result).toEqual({ outcome: "not_attested" });
  });

  it("ignores the bare `allyblockcast` User seat", async () => {
    // A second hat on the same agent, scored as a separate lane by the
    // consistency guard. It must not suppress the App lane's work.
    const result = await check(listing([{ login: "allyblockcast", body: reviewBody(HEAD) }]));
    expect(result).toEqual({ outcome: "not_attested" });
  });

  it("ignores a human review that quotes the attestation line", async () => {
    const result = await check(listing([{ login: "kkroo", body: reviewBody(HEAD) }]));
    expect(result).toEqual({ outcome: "not_attested" });
  });

  it("accepts the `app/<slug>` identity form GitHub also exposes", async () => {
    const result = await check(listing([{ login: "app/allyblockcast", body: reviewBody(HEAD) }]));
    expect(result).toEqual({ outcome: "attested", attestingReviewCount: 1 });
  });

  it("does not attest when the body carries no attestation line at all", async () => {
    // The non-canonical "## CTO review" shape observed on #1316.
    const result = await check(
      listing([{ login: APP, body: "## CTO review — mechanism is correct\n\nLooks fine." }]),
    );
    expect(result).toEqual({ outcome: "not_attested" });
  });

  it("does not attest when the body carries two attestations (ambiguous)", async () => {
    // extractAllyReviewedHeadSha returns null on ambiguity rather than picking
    // one; an ambiguous body must not be able to suppress a wake.
    const result = await check(
      listing([{ login: APP, body: `${reviewBody(HEAD)}\nReviewed head: ${OTHER_HEAD}` }]),
    );
    expect(result).toEqual({ outcome: "not_attested" });
  });

  it("returns unknown when no reviewer bot login is configured", async () => {
    // No hardcoded default identity: the other suppression path in the webhook
    // (isReviewerSelfEchoReview) is inert when prReviewerBotLogin is unset, and
    // suppressing here on a guessed login would disagree with it.
    let called = 0;
    const result = await allyReviewAlreadyAttestsHead({
      repoFullName: "Blockcast/paperclip",
      prNumber: 1316,
      headSha: HEAD,
      botLogin: "  ",
      listPrReviews: async () => {
        called += 1;
        return [{ login: APP, body: reviewBody(HEAD), createdAt: "2026-09-05T00:00:00Z" }];
      },
    });
    expect(result).toMatchObject({ outcome: "unknown" });
    expect(called).toBe(0);
  });

  it("returns unknown — not not_attested — when GitHub cannot be listed", async () => {
    const result = await check(async () => null);
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown when listing throws", async () => {
    const result = await check(async () => {
      throw new Error("socket hang up");
    });
    expect(result).toMatchObject({ outcome: "unknown" });
    expect(result.outcome === "unknown" && result.reason).toContain("socket hang up");
  });

  it("returns unknown for a short or absent head rather than guessing", async () => {
    const listed = listing([{ login: APP, body: reviewBody(HEAD) }]);
    for (const bad of ["", "a47d93f3", "not-a-sha"]) {
      const result = await check(listed, bad);
      expect(result.outcome).toBe("unknown");
    }
  });

  it("matches the head case-insensitively", async () => {
    const result = await check(listing([{ login: APP, body: reviewBody(HEAD.toUpperCase()) }]));
    expect(result).toEqual({ outcome: "attested", attestingReviewCount: 1 });
  });

  it("does not call GitHub at all when the head is unusable", async () => {
    let called = 0;
    await check(async () => {
      called += 1;
      return [];
    }, "");
    expect(called).toBe(0);
  });
});
