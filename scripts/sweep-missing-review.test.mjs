import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_GRACE_MINUTES,
  DEFAULT_MIN_SIBLING_CHECKS,
  SELF_CHECK_NAME,
  classifyPullRequest,
  collapseHeadChecks,
  sweep,
} from "./sweep-missing-review.mjs";
import { publishableCount, renderSummary } from "./report-missing-review-sweep.mjs";

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

function ownRow(conclusion, completedAt = "2026-11-09T17:30:00Z") {
  return { name: SELF_CHECK_NAME, conclusion, status: "COMPLETED", completedAt };
}

const REVIEW_OK = {
  name: "review",
  conclusion: "SUCCESS",
  status: "COMPLETED",
  completedAt: "2026-11-09T18:00:00Z",
};

describe("retiring this sweep's own row", () => {
  it("reports `resolved` when the verdict arrived and our NEUTRAL row still stands", () => {
    // A check-run does not expire. Left alone, the row published while the
    // verdict was absent sits at that SHA forever and every latest-per-name
    // reader keeps scoring the head NOT-EVALUATED after it was reviewed.
    const result = classifyPullRequest(
      pr(head({ suites: [suite([...filler(19), REVIEW_OK, ownRow("NEUTRAL")])] })),
      { now: NOW },
    );
    assert.equal(result.verdict, "resolved");
    assert.equal(result.resolution.number, 3602);
    assert.equal(result.resolution.head.length, 40);
  });

  it("reports plain `present` once our own row has already been superseded", () => {
    const result = classifyPullRequest(
      pr(head({ suites: [suite([...filler(19), REVIEW_OK, ownRow("SUCCESS", "2026-11-09T18:05:00Z")])] })),
      { now: NOW },
    );
    assert.equal(result.verdict, "present");
  });

  it("takes the LATEST of our own rows, so a retired head does not re-resolve", () => {
    const result = classifyPullRequest(
      pr(
        head({
          suites: [
            suite([
              ...filler(19),
              REVIEW_OK,
              ownRow("NEUTRAL", "2026-11-09T17:00:00Z"),
              ownRow("SUCCESS", "2026-11-09T18:10:00Z"),
            ]),
          ],
        }),
      ),
      { now: NOW },
    );
    assert.equal(result.verdict, "present");
  });

  it("marks a still-missing head as alreadyPublished so it is not re-posted hourly", () => {
    const result = classifyPullRequest(
      pr(head({ suites: [suite([...filler(20), ownRow("NEUTRAL")])] })),
      { now: NOW },
    );
    assert.equal(result.verdict, "missing");
    assert.equal(result.finding.alreadyPublished, true);
  });

  it("does not count our own row as a sibling check", () => {
    // Otherwise the detector bootstraps its own in-flight test: one posted row
    // is one more "sibling", and the next sweep believes CI reported here.
    const runs = [...filler(DEFAULT_MIN_SIBLING_CHECKS - 1), ownRow("NEUTRAL")];
    const result = classifyPullRequest(pr(head({ suites: [suite(runs)] })), { now: NOW });
    assert.equal(result.verdict, "skipped");
    assert.match(result.reason, /has not reported yet/);
    assert.match(result.reason, new RegExp(`only ${DEFAULT_MIN_SIBLING_CHECKS - 1} check`));
  });
});

function pageBody(nodes, errors) {
  const body = {
    data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
  };
  if (errors) body.errors = errors;
  return JSON.stringify(body);
}

describe("sweep() over a `gh` invocation that exits non-zero", () => {
  // MEASURED 2026-11-09: `gh api graphql` exits NON-ZERO on any `errors[]`,
  // path-scoped ones included, while still printing a complete `data`. A
  // RESOURCE_LIMITS_EXCEEDED on one nested field -- the exact case this sweep
  // exists to report as UNPROVEN -- therefore arrives as a REJECTION. Read
  // only the resolved path and every partial-result branch is unreachable.
  const partialBody = pageBody(
    [pr(head({ suites: [suite(null, 12)] }))],
    [{ type: "RESOURCE_LIMITS_EXCEEDED", path: ["repository", "pullRequests", "nodes", 0], message: "too complex" }],
  );

  it("recovers the body from the rejection and reports the head UNPROVEN", async () => {
    const report = await sweep({
      owner: "Blockcast",
      repo: "paperclip",
      checkName: "review",
      runner: async () => {
        const error = new Error("exit status 1");
        error.stdout = partialBody;
        throw error;
      },
    });
    assert.equal(report.scanned, 1);
    assert.deepEqual(report.findings, []);
    assert.deepEqual(report.partialErrorTypes, ["RESOURCE_LIMITS_EXCEEDED"]);
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /UNPROVEN/);
  });

  it("still succeeds on the ordinary resolved path", async () => {
    const report = await sweep({
      owner: "Blockcast",
      repo: "paperclip",
      checkName: "review",
      runner: async () => ({ stdout: pageBody([pr(head({ suites: [suite(filler(20))] }))]) }),
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].number, 3602);
    assert.equal(report.findings[0].alreadyPublished, false);
  });

  it("re-throws when the rejection carries no body — a real transport failure stays fatal", async () => {
    await assert.rejects(
      sweep({
        owner: "Blockcast",
        repo: "paperclip",
        checkName: "review",
        runner: async () => {
          const error = new Error("dial tcp: connection refused");
          error.stdout = "";
          throw error;
        },
      }),
      /connection refused/,
    );
  });

  it("re-throws when the recovered body carries no `data`", async () => {
    await assert.rejects(
      sweep({
        owner: "Blockcast",
        repo: "paperclip",
        checkName: "review",
        runner: async () => {
          const error = new Error("exit status 1");
          error.stdout = JSON.stringify({ errors: [{ message: "Bad credentials" }] });
          throw error;
        },
      }),
      /exit status 1/,
    );
  });

  it("is fatal on a NON-path-scoped GraphQL error even when `data` is present", async () => {
    await assert.rejects(
      sweep({
        owner: "Blockcast",
        repo: "paperclip",
        checkName: "review",
        runner: async () => ({ stdout: pageBody([], [{ message: "API rate limit exceeded" }]) }),
      }),
      /rate limit exceeded/,
    );
  });
});

describe("report", () => {
  const base = {
    checkName: "review",
    selfCheckName: SELF_CHECK_NAME,
    scanned: 10,
    findings: [],
    resolutions: [],
    skipped: [],
    partialErrorTypes: [],
    measuredAt: "2026-11-09T21:41:00Z",
  };

  it("gates publishing on rows that will actually be POSTed, not on findings", () => {
    // A sweep can find nothing NEW and still owe a retirement row. Gating the
    // publish step on `findings` would strand the stale marker on exactly the
    // heads that recovered.
    const report = {
      ...base,
      findings: [{ number: 1, head: "a".repeat(40), alreadyPublished: true, checkNamesPresent: 9 }],
      resolutions: [{ number: 2, head: "b".repeat(40), checkNamesPresent: 9 }],
    };
    assert.equal(report.findings.length, 1);
    assert.equal(publishableCount(report), 1);
    assert.equal(publishableCount({ ...base }), 0);
  });

  it("surfaces the UNPROVEN count in the warning block, not only inside <details>", () => {
    // A guard that went quietly blind over half the repo renders, collapsed,
    // exactly like a clean run.
    const summary = renderSummary({
      ...base,
      skipped: [
        { number: 7, reason: "head check surface incomplete; UNPROVEN, not clean" },
        { number: 8, reason: "only 1 check(s) at head; CI has not reported yet" },
      ],
    });
    const warning = summary.slice(summary.indexOf("> [!WARNING]"), summary.indexOf("<details>"));
    assert.match(warning, /\*\*1\*\* of 10 head\(s\)/);
    assert.match(warning, /#7/);
    assert.doesNotMatch(warning, /#8/);
  });

  it("raises no warning when every head was read whole", () => {
    const summary = renderSummary({
      ...base,
      skipped: [{ number: 8, reason: "only 1 check(s) at head; CI has not reported yet" }],
    });
    assert.doesNotMatch(summary, /\[!WARNING\]/);
  });

  it("names the heads whose finding this run retires", () => {
    const summary = renderSummary({ ...base, resolutions: [{ number: 42, head: "c".repeat(40) }] });
    assert.match(summary, /supersedes with a `success` row|supersedes/);
    assert.match(summary, /#42/);
  });
});
