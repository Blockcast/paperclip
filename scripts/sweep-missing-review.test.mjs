import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GRACE_MINUTES,
  DEFAULT_MIN_SIBLING_CHECKS,
  classifyPullRequest,
  collapseHeadChecks,
} from "./sweep-missing-review.mjs";

const NOW = Date.parse("2026-11-09T19:00:00Z");
const OLD_HEAD = "2026-11-09T16:00:00Z";

function suite(runs, totalCount = runs?.length ?? 0) {
  return { checkRuns: { totalCount, nodes: runs } };
}

function pr(commit, overrides = {}) {
  return {
    number: 3602,
    url: "https://github.com/Blockcast/paperclip/pull/3602",
    isDraft: false,
    author: { login: "allyblockcast" },
    commits: { nodes: [{ commit }] },
    ...overrides,
  };
}

function head({ suites, totalCount, contexts = [], committedDate = OLD_HEAD }) {
  return {
    oid: "a3f7d784fc606f1addc4b503b504304a1e0b1e6e",
    committedDate,
    checkSuites: { totalCount: totalCount ?? suites.length, nodes: suites },
    status: contexts.length ? { contexts } : null,
  };
}

function filler(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `filler-${index}`,
    conclusion: "SUCCESS",
    status: "COMPLETED",
    completedAt: "2026-11-09T17:00:00Z",
  }));
}

describe("collapseHeadChecks", () => {
  it("keeps the NEWEST attempt when one check name reported twice at one head", () => {
    // The 2026-11-09 shape: `review` failed, a PR body edit fixed the template
    // gate, and the re-run went green at the same head. A flat scan sees both
    // and a merge gate sees only the second.
    const { byName, unreadable } = collapseHeadChecks(
      head({
        suites: [
          suite([
            { name: "review", conclusion: "FAILURE", status: "COMPLETED", completedAt: "2026-11-09T04:36:34Z" },
            { name: "review", conclusion: "SUCCESS", status: "COMPLETED", completedAt: "2026-11-09T08:49:39Z" },
          ]),
        ],
      }),
    );
    assert.equal(unreadable, false);
    assert.equal(byName.get("review").run.conclusion, "SUCCESS");
  });

  it("unions the commit-status surface, which carries names the check-run surface does not", () => {
    const { byName } = collapseHeadChecks(
      head({
        suites: [suite(filler(2))],
        contexts: [{ context: "review", state: "SUCCESS", createdAt: "2026-11-09T18:31:10Z" }],
      }),
    );
    assert.ok(byName.has("review"));
  });

  it("reports UNREADABLE when nodes is null but totalCount is positive", () => {
    // RESOURCE_LIMITS_EXCEEDED nulls the field and leaves the count, and `gh`
    // still exits 0. Read as an empty set this reports every PR as missing its
    // verdict -- a repo-wide false CI outage.
    const { byName, unreadable } = collapseHeadChecks(head({ suites: [suite(null, 5)] }));
    assert.equal(unreadable, true);
    assert.equal(byName.size, 0);
  });

  it("reports UNREADABLE when a page is silently truncated", () => {
    const { unreadable } = collapseHeadChecks(head({ suites: [suite(filler(3), 41)] }));
    assert.equal(unreadable, true);
  });

  it("reports UNREADABLE when the whole checkSuites connection is null", () => {
    const { unreadable } = collapseHeadChecks({
      oid: "deadbeef",
      committedDate: OLD_HEAD,
      checkSuites: { totalCount: 7, nodes: null },
    });
    assert.equal(unreadable, true);
  });
});

describe("classifyPullRequest", () => {
  it("flags a head where CI reported and `review` did not", () => {
    const result = classifyPullRequest(pr(head({ suites: [suite(filler(20))] })), { now: NOW });
    assert.equal(result.verdict, "missing");
    assert.equal(result.finding.checkNamesPresent, 20);
    assert.equal(result.finding.number, 3602);
  });

  it("does not flag a head that already carries the verdict, even a red one", () => {
    // A red `review` is a verdict. This sweep detects ABSENCE, never failure --
    // conflating the two would make it re-report every genuinely failing PR.
    const result = classifyPullRequest(
      pr(
        head({
          suites: [
            suite([
              ...filler(19),
              { name: "review", conclusion: "FAILURE", status: "COMPLETED", completedAt: "2026-11-09T05:55:05Z" },
            ]),
          ],
        }),
      ),
      { now: NOW },
    );
    assert.equal(result.verdict, "present");
  });

  it("skips rather than flags when the head check surface is unproven", () => {
    const result = classifyPullRequest(pr(head({ suites: [suite(null, 5)] })), { now: NOW });
    assert.equal(result.verdict, "skipped");
    assert.match(result.reason, /UNPROVEN/);
  });

  it("skips a head where CI has not reported yet", () => {
    const result = classifyPullRequest(
      pr(head({ suites: [suite(filler(DEFAULT_MIN_SIBLING_CHECKS - 1))] })),
      { now: NOW },
    );
    assert.equal(result.verdict, "skipped");
    assert.match(result.reason, /has not reported yet/);
  });

  it("skips a freshly pushed head inside the grace window", () => {
    const committedDate = new Date(NOW - (DEFAULT_GRACE_MINUTES - 5) * 60000).toISOString();
    const result = classifyPullRequest(
      pr(head({ suites: [suite(filler(20))], committedDate })),
      { now: NOW },
    );
    assert.equal(result.verdict, "skipped");
    assert.match(result.reason, /grace/);
  });

  it("skips a pull request whose head commit was not returned", () => {
    const result = classifyPullRequest({ number: 1, commits: { nodes: [] } }, { now: NOW });
    assert.equal(result.verdict, "skipped");
  });

  it("honours a non-default check name", () => {
    const commit = head({ suites: [suite([...filler(19), { name: "verify", conclusion: "SUCCESS", status: "COMPLETED", completedAt: OLD_HEAD }])] });
    assert.equal(classifyPullRequest(pr(commit), { checkName: "verify", now: NOW }).verdict, "present");
    assert.equal(classifyPullRequest(pr(commit), { checkName: "review", now: NOW }).verdict, "missing");
  });
});
