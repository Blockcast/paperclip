/**
 * The SHA-scoped peer enumeration behind `gate/ally-comment-findings`
 * (PEN-3818).
 *
 * A commit status is keyed by SHA; the gate's verdict was computed from one
 * pull request's review history. Nothing reconciled those two scopes, so
 * opening any pull request at a victim PR's head SHA published the new PR's
 * legitimately fail-open green over the victim's red findings gate — a
 * merge-control bypass whose only requirement is the ability to open a pull
 * request. Reproduced against production on 2026-10-05.
 *
 * These cases pin the parse, which is where the two filters that make the
 * enumeration safe actually live.
 */
import { describe, expect, it } from "vitest";
import { parseOpenPullRequestsAtHeadPayload } from "../services/github-app-auth.js";

const SHA = "44d8a0abf47d975aef78620239b1e9e1f85b04d9";
const OTHER_SHA = "0000000000000000000000000000000000000000";

const pr = (overrides: Record<string, unknown>) => ({
  number: 2202,
  state: "open",
  html_url: "https://github.com/Blockcast/paperclip/pull/2202",
  head: { sha: SHA },
  ...overrides,
});

describe("parseOpenPullRequestsAtHeadPayload", () => {
  it("keeps open pull requests whose head is exactly this commit", () => {
    expect(parseOpenPullRequestsAtHeadPayload([pr({})], SHA)).toEqual({
      pullRequests: [{ number: 2202, url: "https://github.com/Blockcast/paperclip/pull/2202" }],
    });
  });

  it("fails closed on a non-array body instead of reporting zero peers", () => {
    // The dangerous direction, and the one this whole enumeration exists to
    // avoid: the caller reads "no peers" as licence to publish its own green,
    // so a body it could not read must not look like an empty one.
    for (const body of [null, undefined, {}, "[]", 0]) {
      expect(parseOpenPullRequestsAtHeadPayload(body, SHA)).toEqual({
        error: "open_pull_requests_at_head_malformed",
      });
    }
  });

  it("drops closed and merged pull requests", () => {
    // `GET /commits/{sha}/pulls` returns every PR the commit is associated
    // with, closed ones included. A verdict is only a property of the heads
    // that can still merge; a closed PR's stale red would pin an open sibling
    // red forever with no lever to clear it.
    const result = parseOpenPullRequestsAtHeadPayload(
      [pr({ number: 2247, state: "closed" }), pr({ number: 2290, state: "open" })],
      SHA,
    );
    expect(result).toEqual({ pullRequests: [expect.objectContaining({ number: 2290 })] });
  });

  it("drops a pull request that merely contains this commit", () => {
    // The endpoint also returns a PR whose branch contains the commit without
    // it being the head. A status is written at one SHA and read as that
    // tree's verdict, so a review of a LATER head says nothing about this one:
    // crediting it would let a descendant's finding redden an ancestor nobody
    // reviewed, and a descendant's clean review hide a finding raised here.
    const result = parseOpenPullRequestsAtHeadPayload([pr({ head: { sha: OTHER_SHA } })], SHA);
    expect(result).toEqual({ pullRequests: [] });
  });

  it("compares SHAs case-insensitively", () => {
    const result = parseOpenPullRequestsAtHeadPayload([pr({ head: { sha: SHA.toUpperCase() } })], SHA);
    expect(result).toEqual({ pullRequests: [expect.objectContaining({ number: 2202 })] });
  });

  it("skips malformed entries without dropping the rest", () => {
    const result = parseOpenPullRequestsAtHeadPayload(
      [
        { number: "2247", state: "open", head: { sha: SHA } },
        pr({ head: undefined }),
        pr({ number: 2290 }),
      ],
      SHA,
    );
    expect(result).toEqual({ pullRequests: [expect.objectContaining({ number: 2290 })] });
  });

  it("reports a missing html_url as null rather than dropping the peer", () => {
    // The URL only retargets the published status. A peer whose red must be
    // honoured is not allowed to vanish because its link was unreadable.
    const result = parseOpenPullRequestsAtHeadPayload([pr({ html_url: null })], SHA);
    expect(result).toEqual({ pullRequests: [{ number: 2202, url: null }] });
  });
});
