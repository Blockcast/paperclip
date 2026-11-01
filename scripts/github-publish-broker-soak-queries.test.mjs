import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BROKERED_TOOLS,
  BROKER_QUERIES,
  BROKER_STREAM,
  REFUSAL_OPENINGS,
  SELF_PREFIX,
  assertWindow,
  buildCountQuery,
  classifyBrokerLine,
  escapeForLogqlRegex,
  formatReport,
  parseArgs,
  windowNanos,
} from "./github-publish-broker-soak-queries.mjs";

// Verbatim from the broker on `master` 8be492039. If a message is reworded
// these fixtures must be re-copied from source -- that is the point of them.
const LINES = {
  listening: `${SELF_PREFIX}listening on /run/paperclip/github-broker.sock, publishing from under /paperclip/work`,
  startupUnset: `${SELF_PREFIX}PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset; refusing to start without a workspace root to confine requests to`,
  startupOther: "listen EADDRINUSE: address already in use /run/paperclip/github-broker.sock",
  acceptGit: `${SELF_PREFIX}git in /paperclip/work/repo`,
  acceptGh: `${SELF_PREFIX}gh in /paperclip/work/repo`,
  acceptMcp: `${SELF_PREFIX}github-mcp-server in /paperclip/work/repo`,
  refusalNotPush: "the broker performs pushes, and this is `git status`. Everything git does that is not a publish runs locally in your own container — call it there.",
  refusalConfig: "refusing a push that sets git config itself (`-c`). `credential.helper` is multi-valued",
  refusalGhVerb: 'refusing `gh auth`: it is a route from "the broker runs gh for me" back to holding the token itself',
  refusalRelCwd: "refusing a relative working directory `../elsewhere`",
  refusalOutside: "refusing a working directory outside the shared workspace: `/etc` resolves to `/etc`, which is not under `/paperclip/work`.",
  refusalArgPath: "refusing an argument that names a file outside the shared workspace: `/etc/shadow` resolves to `/etc/shadow`.",
};

/** Compile the `|~ \`...\`` matcher out of a query so the test checks the SHIPPED regex. */
function regexOf(id) {
  const q = BROKER_QUERIES.find((x) => x.id === id);
  const m = /\|~ `([^`]+)`/.exec(q.logql);
  assert.ok(m, `${id} has no |~ matcher`);
  return new RegExp(m[1]);
}

describe("classifyBrokerLine", () => {
  it("separates the three §5.3 categories on real broker strings", () => {
    assert.equal(classifyBrokerLine(LINES.listening), "startup_listening");
    assert.equal(classifyBrokerLine(LINES.startupUnset), "startup_failure_workspace_root");
    assert.equal(classifyBrokerLine(LINES.startupOther), "startup_failure_other");
    for (const k of ["acceptGit", "acceptGh", "acceptMcp"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "invocation_accepted", k);
    }
    for (const k of ["refusalNotPush", "refusalConfig", "refusalGhVerb", "refusalRelCwd", "refusalOutside", "refusalArgPath"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "policy_refusal", k);
    }
  });

  it("covers every brokered tool, so a fourth door cannot be added silently", () => {
    assert.deepEqual(BROKERED_TOOLS, ["git", "gh", "github-mcp-server"]);
    for (const tool of BROKERED_TOOLS) {
      assert.equal(classifyBrokerLine(`${SELF_PREFIX}${tool} in /paperclip/work/x`), "invocation_accepted");
    }
  });

  it("does not mistake a self-prefixed novelty for a startup failure", () => {
    // The residual bucket is 'unprefixed', so a NEW prefixed line must land in
    // self_reported_other and be surfaced by the partition check -- not be
    // silently counted as an unexpected startup error.
    assert.equal(classifyBrokerLine(`${SELF_PREFIX}something nobody has written yet`), "self_reported_other");
  });

  it("treats a refusal as a refusal even though it is unprefixed", () => {
    // broker.ts:363 passes PublishBrokerRefusal.message through verbatim. If
    // that ever gains the self prefix this assertion fails, which is correct:
    // the anchored refusal query would stop matching.
    for (const opening of REFUSAL_OPENINGS) {
      assert.ok(!opening.startsWith(SELF_PREFIX));
      assert.equal(classifyBrokerLine(`${opening}whatever`), "policy_refusal");
    }
  });

  it("handles empty and nullish input without throwing", () => {
    assert.equal(classifyBrokerLine(""), "startup_failure_other");
    assert.equal(classifyBrokerLine(undefined), "startup_failure_other");
  });
});

describe("shipped LogQL matchers agree with classifyBrokerLine", () => {
  it("the refusal regex matches every refusal and no accept or startup line", () => {
    const re = regexOf("policy_refusal");
    for (const k of ["refusalNotPush", "refusalConfig", "refusalGhVerb", "refusalRelCwd", "refusalOutside", "refusalArgPath"]) {
      assert.ok(re.test(LINES[k]), `should match ${k}`);
    }
    for (const k of ["listening", "startupUnset", "startupOther", "acceptGit", "acceptGh", "acceptMcp"]) {
      assert.ok(!re.test(LINES[k]), `should NOT match ${k}`);
    }
  });

  it("the accept regex matches every door and nothing else", () => {
    const re = regexOf("invocation_accepted");
    for (const k of ["acceptGit", "acceptGh", "acceptMcp"]) assert.ok(re.test(LINES[k]), k);
    for (const k of ["listening", "startupUnset", "startupOther", "refusalConfig"]) {
      assert.ok(!re.test(LINES[k]), `should NOT match ${k}`);
    }
  });

  it("the accept regex is anchored, so a refusal quoting the prefix cannot score as an accept", () => {
    const re = regexOf("invocation_accepted");
    assert.ok(!re.test(`refusing a thing that mentions ${SELF_PREFIX}git in /tmp`));
  });
});

describe("the §5.3 gap is encoded, not merely documented", () => {
  it("marks child non-zero exits NOT observable", () => {
    const q = BROKER_QUERIES.find((x) => x.id === "child_nonzero_exit");
    assert.equal(q.category, "c");
    assert.equal(q.observable, false, "sendExit() is socket-only; a 0 here would be a false all-clear");
  });

  it("marks protocol refusals NOT observable", () => {
    assert.equal(BROKER_QUERIES.find((x) => x.id === "protocol_refusal").observable, false);
  });

  it("covers all three §5.3 categories plus a denominator", () => {
    const cats = new Set(BROKER_QUERIES.map((q) => q.category));
    for (const c of ["a", "b", "c", "denominator"]) assert.ok(cats.has(c), `missing category ${c}`);
  });

  it("every query targets the broker container and nothing broader", () => {
    for (const q of BROKER_QUERIES) {
      assert.ok(q.logql.startsWith(BROKER_STREAM), `${q.id} is not scoped to the broker stream`);
    }
    assert.match(BROKER_STREAM, /container="github-publish-broker"/);
  });
});

describe("query construction", () => {
  it("wraps a selector in a counting aggregation", () => {
    assert.equal(buildCountQuery('{a="b"}', "24h"), 'sum(count_over_time({a="b"} [24h]))');
  });

  it("rejects a window Loki would not parse", () => {
    for (const bad of ["24", "h", "", "1 hour", "24H", undefined]) {
      assert.throws(() => assertWindow(bad), /invalid Loki window/);
    }
    for (const good of ["30s", "5m", "24h", "7d", "2w"]) assert.equal(assertWindow(good), good);
  });

  it("converts windows to nanoseconds", () => {
    assert.equal(windowNanos("1h"), 3600e9);
    assert.equal(windowNanos("7d"), 604800e9);
  });

  it("escapes regex metacharacters and refuses a backtick", () => {
    assert.equal(escapeForLogqlRegex("a.b+c"), "a\\.b\\+c");
    assert.equal(escapeForLogqlRegex("github-mcp-server"), "github-mcp-server");
    assert.throws(() => escapeForLogqlRegex("a`b"), /backtick/);
  });
});

describe("parseArgs", () => {
  it("defaults to a 24h text report", () => {
    assert.deepEqual(parseArgs([]), { window: "24h", json: false });
  });
  it("accepts both --window forms and --json", () => {
    assert.deepEqual(parseArgs(["--window", "7d", "--json"]), { window: "7d", json: true });
    assert.deepEqual(parseArgs(["--window=30m"]), { window: "30m", json: false });
  });
  it("rejects an unknown flag rather than ignoring it", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  });
});

describe("formatReport", () => {
  const rows = [
    { id: "x", category: "a", label: "startup OK", observable: true, count: 3 },
    { id: "y", category: "c", label: "child non-zero exits", observable: false, count: null },
  ];

  it("prints NOT OBSERVABLE rather than 0 for an unobservable category", () => {
    const out = formatReport(rows, { window: "24h", streamTotal: 3, newest: "2026-11-01T09:00:00.000Z" });
    assert.match(out, /child non-zero exits\s+NOT OBSERVABLE/);
    assert.doesNotMatch(out, /child non-zero exits\s+0/);
  });

  it("says an empty stream means 'nothing ran', not 'ran cleanly'", () => {
    const out = formatReport(rows, { window: "24h", streamTotal: 0, newest: null });
    assert.match(out, /broker stream is EMPTY/);
    assert.match(out, /NOT 'the broker ran cleanly'/);
  });

  it("flags an incomplete partition so a new log line cannot hide", () => {
    const out = formatReport(rows, { window: "24h", streamTotal: 9, newest: "2026-11-01T09:00:00.000Z" });
    assert.match(out, /6 line\(s\) matched no category/);
  });

  it("stays quiet when the partition is complete", () => {
    const out = formatReport(rows, { window: "24h", streamTotal: 3, newest: "2026-11-01T09:00:00.000Z" });
    assert.doesNotMatch(out, /matched no category/);
  });
});
