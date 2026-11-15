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
 * enumeration safe actually live. PEN-6341 item 2 slice 4 moved the transport
 * from `GET /commits/{sha}/pulls` to GraphQL `Commit.associatedPullRequests`,
 * so the input is now a page rather than a REST body — every filter below is
 * the same filter, re-pinned on the new shape, plus one case the REST reader
 * had no way to express.
 */
import { describe, expect, it } from "vitest";
import {
  parseOpenPullRequestsAtHeadPage,
  type GraphQlCommitPullRequest,
  type GraphQlCommitPullRequestPage,
} from "../services/github-app-auth.js";

const SHA = "44d8a0abf47d975aef78620239b1e9e1f85b04d9";
const OTHER_SHA = "0000000000000000000000000000000000000000";

const pr = (overrides: Partial<GraphQlCommitPullRequest> = {}): GraphQlCommitPullRequest => ({
  number: 2202,
  state: "OPEN",
  url: "https://github.com/Blockcast/paperclip/pull/2202",
  headRefOid: SHA,
  ...overrides,
});

const page = (
  pullRequests: GraphQlCommitPullRequest[],
  extra: Partial<Extract<GraphQlCommitPullRequestPage, { ok: true }>> = {},
): GraphQlCommitPullRequestPage => ({
  ok: true,
  pullRequests,
  malformed: 0,
  hasNextPage: false,
  endCursor: null,
  ...extra,
});

describe("parseOpenPullRequestsAtHeadPage", () => {
  it("keeps open pull requests whose head is exactly this commit", () => {
    expect(parseOpenPullRequestsAtHeadPage(page([pr()]), SHA)).toEqual({
      pullRequests: [{ number: 2202, url: "https://github.com/Blockcast/paperclip/pull/2202" }],
    });
  });

  it("fails closed on an unreadable page instead of reporting zero peers", () => {
    // The dangerous direction, and the one this whole enumeration exists to
    // avoid: the caller reads "no peers" as licence to publish its own green,
    // so a page it could not read must not look like an empty one.
    expect(parseOpenPullRequestsAtHeadPage({ ok: false, reason: "commit_absent" }, SHA)).toEqual({
      error: "open_pull_requests_at_head_commit_absent",
    });
    expect(parseOpenPullRequestsAtHeadPage({ ok: false, reason: "transport" }, SHA)).toEqual({
      error: "open_pull_requests_at_head_fetch_failed",
    });
    expect(parseOpenPullRequestsAtHeadPage({ ok: false, reason: "payload_malformed" }, SHA)).toEqual({
      error: "open_pull_requests_at_head_malformed",
    });
  });

  it("fails closed when the connection counted a row this token could not resolve", () => {
    // The case the REST reader could not express, and the reason `totalCount`
    // is selected at all. A GraphQL connection counts rows the token cannot
    // read and renders each as a null node, so mapping `nodes[]` alone returns
    // a well-formed, confident, SHORTER list. Short IS the bypass here.
    expect(parseOpenPullRequestsAtHeadPage(page([pr()], { malformed: 1 }), SHA)).toEqual({
      error: "open_pull_requests_at_head_malformed",
    });
    // And a shortfall with NO readable peers must not read as "no peers".
    expect(parseOpenPullRequestsAtHeadPage(page([], { malformed: 2 }), SHA)).toEqual({
      error: "open_pull_requests_at_head_malformed",
    });
  });

  it("drops closed and merged pull requests", () => {
    // The association set includes closed and merged rows. A verdict is only a
    // property of the heads that can still merge; a closed PR's stale red would
    // pin an open sibling red forever with no lever to clear it.
    const result = parseOpenPullRequestsAtHeadPage(
      page([
        pr({ number: 2247, state: "CLOSED" }),
        pr({ number: 2248, state: "MERGED" }),
        pr({ number: 2290, state: "OPEN" }),
      ]),
      SHA,
    );
    expect(result).toEqual({ pullRequests: [expect.objectContaining({ number: 2290 })] });
  });

  it("drops a pull request that merely contains this commit", () => {
    // The association set also carries a PR whose branch contains the commit
    // without it being the head. A status is written at one SHA and read as
    // that tree's verdict, so a review of a LATER head says nothing about this
    // one: crediting it would let a descendant's finding redden an ancestor
    // nobody reviewed, and a descendant's clean review hide a finding raised
    // here.
    const result = parseOpenPullRequestsAtHeadPage(page([pr({ headRefOid: OTHER_SHA })]), SHA);
    expect(result).toEqual({ pullRequests: [] });
  });

  it("drops a pull request whose head could not be read at all", () => {
    // An unreadable head cannot be matched against this SHA, and an unmatched
    // peer must not be credited. This is the quiet half of the filter above.
    const result = parseOpenPullRequestsAtHeadPage(page([pr({ headRefOid: null })]), SHA);
    expect(result).toEqual({ pullRequests: [] });
  });

  it("compares SHAs case-insensitively", () => {
    const result = parseOpenPullRequestsAtHeadPage(page([pr({ headRefOid: SHA.toUpperCase() })]), SHA);
    expect(result).toEqual({ pullRequests: [expect.objectContaining({ number: 2202 })] });
  });

  it("drops a row whose state could not be read", () => {
    // `state` is the only thing separating a mergeable peer from a closed one,
    // so an unreadable state is not an open PR.
    const result = parseOpenPullRequestsAtHeadPage(page([pr({ state: null })]), SHA);
    expect(result).toEqual({ pullRequests: [] });
  });

  it("reports a missing url as null rather than dropping the peer", () => {
    // The URL only retargets the published status. A peer whose red must be
    // honoured is not allowed to vanish because its link was unreadable.
    const result = parseOpenPullRequestsAtHeadPage(page([pr({ url: null })]), SHA);
    expect(result).toEqual({ pullRequests: [{ number: 2202, url: null }] });
  });
});
