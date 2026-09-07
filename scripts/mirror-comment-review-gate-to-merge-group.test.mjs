import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  isMainModule,
  mirrorVerdict,
  parsePrNumberFromQueueRef,
  readGateContext,
  selectLatestStatus,
  truncate,
} from "./mirror-comment-review-gate-to-merge-group.mjs";

const CONTEXT = "gate/ally-comment-findings";
const SHA = "a".repeat(40);

function status(overrides = {}) {
  return {
    context: CONTEXT,
    state: "success",
    description: "Ally's most recent consolidated-review comment for this head reports no unresolved findings.",
    updated_at: "2026-09-06T00:00:00Z",
    ...overrides,
  };
}

describe("parsePrNumberFromQueueRef", () => {
  it("parses the number out of a queue ref", () => {
    assert.equal(
      parsePrNumberFromQueueRef("refs/heads/gh-readonly-queue/master/pr-1431-dd3cf5e7"),
      1431,
    );
  });

  it("tolerates a base branch containing slashes", () => {
    assert.equal(
      parsePrNumberFromQueueRef("refs/heads/gh-readonly-queue/release/v2/pr-987-abc1234"),
      987,
    );
  });

  it("returns null for a ref that is not a queue ref", () => {
    assert.equal(parsePrNumberFromQueueRef("refs/heads/master"), null);
    assert.equal(parsePrNumberFromQueueRef(""), null);
    assert.equal(parsePrNumberFromQueueRef(undefined), null);
  });
});

describe("readGateContext", () => {
  it("reads the context the deployment actually ships", () => {
    const values = ['githubApp:', `  prCommentReviewGateStatusContext: "${CONTEXT}"`, ""].join("\n");
    assert.equal(readGateContext(values), CONTEXT);
  });

  it("treats an empty context as the gate being switched off", () => {
    assert.equal(readGateContext('  prCommentReviewGateStatusContext: ""'), "");
    assert.equal(readGateContext("githubApp: {}"), "");
  });
});

describe("selectLatestStatus", () => {
  it("takes the newest write for the context, not the first listed", () => {
    const chosen = selectLatestStatus(
      [
        status({ state: "failure", updated_at: "2026-09-06T00:00:00Z" }),
        status({ state: "success", updated_at: "2026-09-07T00:00:00Z" }),
      ],
      CONTEXT,
    );
    assert.equal(chosen.state, "success");
  });

  it("ignores other contexts", () => {
    assert.equal(selectLatestStatus([status({ context: "review/ally-complete" })], CONTEXT), null);
  });

  it("returns null when the context was never written", () => {
    assert.equal(selectLatestStatus([], CONTEXT), null);
  });
});

describe("mirrorVerdict", () => {
  // The invariant this whole script exists to hold. A `pending` required status
  // on a queue ref waits the full 6h `checkResponseTimeout` and ejects the
  // entry, and a merge_group run cannot be re-run -- which is the outage
  // BLO-26602 correction #1 describes. Nothing may ever mirror as pending.
  it("never emits pending, for any input", () => {
    const inputs = [
      null,
      status({ state: "pending" }),
      status({ state: "success" }),
      status({ state: "failure" }),
      status({ state: "error" }),
      status({ state: "something-new" }),
    ];
    for (const input of inputs) {
      assert.notEqual(mirrorVerdict(input, { prNumber: 1, prHeadSha: SHA }).state, "pending");
    }
  });

  it("mirrors a blocking verdict so the queue entry fails fast", () => {
    for (const state of ["failure", "error"]) {
      assert.equal(mirrorVerdict(status({ state }), { prNumber: 7, prHeadSha: SHA }).state, "failure");
    }
  });

  it("passes open when the gate never evaluated the PR head", () => {
    const verdict = mirrorVerdict(null, { prNumber: 7, prHeadSha: SHA });
    assert.equal(verdict.state, "success");
    assert.match(verdict.description, /No gate verdict on #7/);
  });

  it("passes open rather than stalling on an unexpected state", () => {
    const verdict = mirrorVerdict(status({ state: "pending" }), { prNumber: 7, prHeadSha: SHA });
    assert.equal(verdict.state, "success");
    assert.match(verdict.description, /passing open rather than stalling/);
  });

  it("carries the gate's own description through so the queue status is self-explaining", () => {
    const verdict = mirrorVerdict(
      status({ state: "failure", description: "Ally's review of this head carries an unresolved finding." }),
      { prNumber: 7, prHeadSha: SHA },
    );
    assert.equal(verdict.description, "Ally's review of this head carries an unresolved finding.");
  });

  it("keeps every description inside GitHub's 140-character limit", () => {
    const verdict = mirrorVerdict(status({ state: "failure", description: "x".repeat(400) }), {
      prNumber: 7,
      prHeadSha: SHA,
    });
    assert.ok(verdict.description.length <= 140, `got ${verdict.description.length}`);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    assert.equal(truncate("short"), "short");
  });

  it("marks truncation visibly", () => {
    assert.equal(truncate("abcdef", 4), "abc…");
  });
});

describe("isMainModule", () => {
  it("is false when the entrypoint is a different file (so importing never runs main)", () => {
    assert.equal(isMainModule("/some/other/entry.mjs", import.meta.url), false);
  });

  it("is true when the entrypoint is this module", () => {
    assert.equal(isMainModule(fileURLToPath(import.meta.url), import.meta.url), true);
  });

  it("is false when there is no entrypoint at all", () => {
    assert.equal(isMainModule("", import.meta.url), false);
  });
});
