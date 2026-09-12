import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GateContextError,
  buildStatusArgs,
  failOpenVerdict,
  isMainModule,
  mirrorVerdict,
  parsePrNumberFromQueueRef,
  readGateContext,
  selectLatestStatus,
  truncate,
  withRetry,
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
  const shipped = (value) => ["githubApp:", `  prCommentReviewGateStatusContext: ${value}`, ""].join("\n");

  // The bug this replaced a single regex to fix: every spelling below is valid
  // YAML and a routine reformat of a deploy file produces them, but only the
  // first one used to parse. The rest returned "" and were routed to the
  // deliberate no-op branch -- switching the merge-queue writer off with a
  // reassuring log line and no failure signal.
  it("reads every one-line YAML spelling of the value", () => {
    const spellings = [
      `"${CONTEXT}"`,
      `'${CONTEXT}'`,
      CONTEXT,
      `"${CONTEXT}" # BLO-29711`,
      `'${CONTEXT}'  # BLO-29711`,
      `${CONTEXT} # BLO-29711`,
      `  ${CONTEXT}  `,
    ];
    for (const spelling of spellings) {
      assert.deepEqual(
        readGateContext(shipped(spelling)),
        { present: true, context: CONTEXT },
        `failed to read: ${spelling}`,
      );
    }
  });

  // Regression guard for the real file rather than a synthetic one. This test
  // runs on every PR, so a values-file reformat fails a re-runnable PR check
  // instead of a merge-queue entry that cannot be re-run.
  it("reads the context out of the values file the deployment actually ships", () => {
    const values = readFileSync(
      new URL("../deploy/helm/paperclip/values.blockcast.yaml", import.meta.url),
      "utf8",
    );
    const resolved = readGateContext(values);
    assert.equal(resolved.present, true);
    assert.ok(resolved.context.length > 0, "shipped values must name a non-empty gate context");
  });

  it("is not confused by the retired-contexts key sitting next to it", () => {
    const values = [
      "githubApp:",
      '  prCommentReviewGateStatusContext: "gate/ally-comment-findings"',
      '  prCommentReviewGateRetiredStatusContexts: "review/ally-comment"',
      "",
    ].join("\n");
    assert.equal(readGateContext(values).context, "gate/ally-comment-findings");
  });

  it("distinguishes the key being absent from the gate being switched off", () => {
    assert.deepEqual(readGateContext("githubApp: {}"), { present: false, context: "" });
    assert.deepEqual(readGateContext(shipped('""')), { present: true, context: "" });
    assert.deepEqual(readGateContext(shipped("''")), { present: true, context: "" });
  });

  // "Switched off" and "I cannot read this" must not share an encoding: once
  // the context is required, silently reading the second as the first is the 6h
  // checkResponseTimeout ejection this whole script exists to prevent.
  it("refuses to guess when the key is present but unreadable", () => {
    const unreadable = [
      "", // `key:` with no value -- YAML null, but also a half-finished edit
      "   ",
      '"gate/unterminated',
      "[gate/ally-comment-findings]",
      "&anchor",
      "|",
    ];
    for (const value of unreadable) {
      assert.throws(
        () => readGateContext(shipped(value)),
        GateContextError,
        `should have refused: ${JSON.stringify(value)}`,
      );
    }
  });

  it("refuses to first-match when the key appears twice", () => {
    const values = [shipped(`"${CONTEXT}"`), shipped('"gate/somewhere-else"')].join("\n");
    assert.throws(() => readGateContext(values), GateContextError);
  });

  it("keeps a '#' that is not a comment", () => {
    assert.equal(readGateContext(shipped("gate/a#b")).context, "gate/a#b");
  });

  it("treats a commented-out key as absent", () => {
    assert.deepEqual(
      readGateContext(`githubApp:\n  # prCommentReviewGateStatusContext: "${CONTEXT}"\n`),
      { present: false, context: "" },
    );
  });

  it("rejects non-text input rather than reporting the gate as off", () => {
    assert.throws(() => readGateContext(undefined), GateContextError);
  });
});

describe("failOpenVerdict", () => {
  // Class 3 in the script header: the context is known but the mirror failed
  // (gh 5xx, secondary rate limit, malformed API JSON). A crash here would
  // eject the queue entry, which is neither of the two outcomes the script
  // promises, so an unexpected error becomes a visible-but-harmless status.
  it("passes open and names the failure", () => {
    const verdict = failOpenVerdict(new Error("gh: HTTP 502"));
    assert.equal(verdict.state, "success");
    assert.match(verdict.description, /gh: HTTP 502/);
  });

  it("never emits pending, and stays inside GitHub's 140-character limit", () => {
    const verdict = failOpenVerdict(new Error("x".repeat(400)));
    assert.notEqual(verdict.state, "pending");
    assert.ok(verdict.description.length <= 140, `got ${verdict.description.length}`);
  });

  it("survives a thrown non-Error", () => {
    assert.equal(failOpenVerdict(undefined).state, "success");
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

describe("withRetry", () => {
  const opts = { attempts: 3, delayMs: 0 };

  it("returns the value without retrying when the call succeeds", () => {
    let calls = 0;
    const value = withRetry("read", () => {
      calls += 1;
      return "ok";
    }, opts);
    assert.equal(value, "ok");
    assert.equal(calls, 1);
  });

  // The defect this guards: a transient 5xx on a READ used to land in the
  // class-3 catch and mirror a blocking verdict as `success`.
  it("survives a transient failure and returns the eventual value", () => {
    let calls = 0;
    const value = withRetry("read", () => {
      calls += 1;
      if (calls < 3) throw new Error("HTTP 502");
      return "ok";
    }, opts);
    assert.equal(value, "ok");
    assert.equal(calls, 3);
  });

  it("rethrows the last error once attempts are exhausted, so class 3 is still the floor", () => {
    let calls = 0;
    assert.throws(
      () => withRetry("read", () => {
        calls += 1;
        throw new Error(`HTTP 502 #${calls}`);
      }, opts),
      /HTTP 502 #3/,
    );
    assert.equal(calls, 3);
  });
});

describe("buildStatusArgs", () => {
  function argOf(args, key) {
    const index = args.findIndex((arg) => typeof arg === "string" && arg.startsWith(`${key}=`));
    return index === -1 ? null : args[index].slice(key.length + 1);
  }

  it("posts to the queue head under the configured context", () => {
    const args = buildStatusArgs({
      repo: "Blockcast/paperclip",
      sha: SHA,
      context: CONTEXT,
      verdict: { state: "success", description: "clean" },
    });
    assert.deepEqual(args.slice(0, 4), ["api", "-X", "POST", `repos/Blockcast/paperclip/statuses/${SHA}`]);
    assert.equal(argOf(args, "context"), CONTEXT);
  });

  // The no-`pending` invariant is proven inside mirrorVerdict; this proves the
  // verdict that was proven is the one that reaches GitHub.
  it("carries the verdict's own state through to the wire", () => {
    for (const state of ["success", "failure"]) {
      const args = buildStatusArgs({
        repo: "o/r",
        sha: SHA,
        context: CONTEXT,
        verdict: { state, description: "d" },
      });
      assert.equal(argOf(args, "state"), state);
    }
  });

  it("never puts pending on the wire for any verdict this module produces", () => {
    const verdicts = [
      mirrorVerdict(status({ state: "failure" }), { prNumber: 1, prHeadSha: SHA }),
      mirrorVerdict(status({ state: "pending" }), { prNumber: 1, prHeadSha: SHA }),
      mirrorVerdict(null, { prNumber: 1, prHeadSha: SHA }),
      failOpenVerdict(new Error("boom")),
    ];
    for (const verdict of verdicts) {
      const args = buildStatusArgs({ repo: "o/r", sha: SHA, context: CONTEXT, verdict });
      assert.notEqual(argOf(args, "state"), "pending");
    }
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
