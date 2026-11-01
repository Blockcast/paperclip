import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROKERED_TOOLS,
  BROKER_QUERIES,
  BROKER_STREAM,
  REFUSAL_OPENINGS,
  SELF_LISTEN,
  SELF_PREFIX,
  SELF_WORKSPACE_UNSET,
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
  // broker.ts:366 NON-refusal branch: whatever parsePublishBrokerRequest or
  // startChild threw, stringified. Arbitrary Node messages -- no fixed shape.
  requestErrorParse: `${SELF_PREFIX}Unexpected end of JSON input`,
  requestErrorSpawn: `${SELF_PREFIX}EACCES: permission denied, mkdir '/paperclip/work/repo/.git'`,
  // Adversarial: a refusal whose agent-supplied value quotes a prefixed shape.
  // classifyBrokerLine uses startsWith, so these are refusals; an UNANCHORED
  // contains-matcher would miscount them as startup or accept lines.
  refusalQuotingListen: `refusing a relative working directory \`${SELF_PREFIX}${SELF_LISTEN} /x\``,
  refusalQuotingUnset: `refusing a relative working directory \`${SELF_PREFIX}${SELF_WORKSPACE_UNSET}\``,
};

/** Compile the `|~ \`...\`` matcher out of a query so the test checks the SHIPPED regex. */
function regexOf(id) {
  const q = BROKER_QUERIES.find((x) => x.id === id);
  const m = /\|~ `([^`]+)`/.exec(q.logql);
  assert.ok(m, `${id} has no |~ matcher`);
  return new RegExp(m[1]);
}

/**
 * Apply a shipped query's LogQL LINE FILTERS to a candidate line, in order.
 * Covers the four forms this file uses: `|=` / `!=` (substring) and `|~` / `!~`
 * (regex). This evaluates the SHIPPED string rather than a restatement of it,
 * so a matcher that drifts from classifyBrokerLine fails here rather than in
 * production six weeks later.
 */
function queryMatches(id, line) {
  const q = BROKER_QUERIES.find((x) => x.id === id);
  assert.ok(q, `no query ${id}`);
  assert.ok(q.logql.startsWith(BROKER_STREAM), `${id} is not scoped to the broker stream`);
  const filters = q.logql.slice(BROKER_STREAM.length);
  const re = /\s*(\|=|!=|\|~|!~)\s*`([^`]*)`/g;
  let m;
  let seen = 0;
  let ok = true;
  while ((m = re.exec(filters)) !== null) {
    seen += 1;
    const [, op, arg] = m;
    const hit = op === "|=" || op === "!=" ? line.includes(arg) : new RegExp(arg).test(line);
    if (hit !== (op === "|=" || op === "|~")) ok = false;
  }
  assert.ok(seen > 0, `${id} has no line filters`);
  return ok;
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

  it("counts the broker.ts:366 non-refusal request error, which is a KNOWN site", () => {
    // Regression for the finding on #3205: this site is logged to stderr with
    // the self prefix and matched no query, so (b) undercounted it AND the
    // partition check cried "a new log line has been added" when none had been.
    for (const k of ["requestErrorParse", "requestErrorSpawn"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "request_error_other", k);
    }
  });

  it("does not mistake a self-prefixed novelty for a startup failure", () => {
    // A genuinely new prefixed line is textually indistinguishable from the
    // :366 error, so it lands in the same counted bucket by design -- never in
    // 'unexpected startup error', which is the unprefixed residual.
    assert.equal(classifyBrokerLine(`${SELF_PREFIX}something nobody has written yet`), "request_error_other");
  });

  it("reads an adversarial refusal that quotes a prefixed shape as a refusal", () => {
    // classifyBrokerLine anchors with startsWith; the shipped matchers must too.
    for (const k of ["refusalQuotingListen", "refusalQuotingUnset"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "policy_refusal", k);
    }
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

  it("EXACTLY ONE observable query matches each fixture, and it is the one the classifier picks", () => {
    // The general form of the #3205 finding: a line the broker really writes
    // matching NO query (undercount + false staleness alarm), or matching TWO
    // (double count). Evaluating the shipped LogQL closes both at once.
    const observable = BROKER_QUERIES.filter((q) => q.observable).map((q) => q.id);
    for (const [name, line] of Object.entries(LINES)) {
      const matched = observable.filter((id) => queryMatches(id, line));
      assert.deepEqual(matched, [classifyBrokerLine(line)], `${name} → ${line}`);
    }
  });

  it("partitions a novel line on BOTH sides of the prefix, so nothing can match nothing", () => {
    const observable = BROKER_QUERIES.filter((q) => q.observable).map((q) => q.id);
    for (const line of [`${SELF_PREFIX}a shape nobody has written yet`, "an unprefixed shape nobody has written yet", ""]) {
      const matched = observable.filter((id) => queryMatches(id, line));
      assert.deepEqual(matched, [classifyBrokerLine(line)], JSON.stringify(line));
    }
  });

  it("the unprefixed residual is anchored and case-SENSITIVE, mirroring startsWith", () => {
    // Was `!= \`prefix\`` (substring) with a `(?i)` refusal exclusion, while the
    // classifier used case-sensitive startsWith. Neither edge mattered in
    // production, but the suite asserts the two agree, so the claim had to be true.
    assert.ok(queryMatches("startup_failure_other", `not at the start: ${SELF_PREFIX}x`));
    assert.ok(queryMatches("startup_failure_other", "REFUSING in shouty caps is not a refusal opening"));
    assert.ok(!queryMatches("startup_failure_other", LINES.refusalConfig));
    assert.ok(!queryMatches("startup_failure_other", LINES.listening));
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

  it("counts the non-refusal request error under (b), observably", () => {
    const q = BROKER_QUERIES.find((x) => x.id === "request_error_other");
    assert.equal(q.category, "b", "a rejected request is a (b) event, not a startup failure");
    assert.equal(q.observable, true, "broker.ts:366 reaches stderr via ctx.log — it IS observable");
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

describe("the runbook cannot drift from the shipped queries", () => {
  const RUNBOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "runbooks", "github-publish-broker-soak-queries.md");

  /** Every LogQL selector line inside a ```logql fence in the runbook. */
  function runbookQueries() {
    const md = readFileSync(RUNBOOK, "utf8");
    const fences = [...md.matchAll(/```logql\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(fences.length > 0, "runbook has no ```logql fence");
    return fences
      .flatMap((f) => f.split("\n"))
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"));
  }

  it("every pasteable query in the runbook is one the script actually ships", () => {
    // The #3205 finding's sibling: a doc that says something the code does not.
    // Three matchers were re-anchored in this change and the fence went stale.
    const shipped = new Set(BROKER_QUERIES.map((q) => q.logql));
    for (const q of runbookQueries()) {
      assert.ok(shipped.has(q), `runbook query is not in BROKER_QUERIES:\n  ${q}`);
    }
  });

  it("documents every observable query, so a counted category cannot go unmentioned", () => {
    const documented = new Set(runbookQueries());
    for (const q of BROKER_QUERIES.filter((x) => x.observable)) {
      assert.ok(documented.has(q.logql), `observable query ${q.id} is missing from the runbook`);
    }
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

  it("flags an incomplete partition as a MATCHER fault, not as a new log line", () => {
    const out = formatReport(rows, { window: "24h", streamTotal: 9, newest: "2026-11-01T09:00:00.000Z" });
    assert.match(out, /6 line\(s\) matched no category/);
    // The categories are total, so "someone added a log line" is the wrong
    // reading and was the false alarm reported on #3205.
    assert.match(out, /does not mean a\s*\n\s*new log line was added/);
    assert.match(out, /does not behave in Loki as classifyBrokerLine does/);
  });

  it("stays quiet when the partition is complete", () => {
    const out = formatReport(rows, { window: "24h", streamTotal: 3, newest: "2026-11-01T09:00:00.000Z" });
    assert.doesNotMatch(out, /matched no category/);
  });
});
