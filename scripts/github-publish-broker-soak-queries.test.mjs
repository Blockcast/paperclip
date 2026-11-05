import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BROKERED_TOOLS,
  BROKER_QUERIES,
  BROKER_STREAM,
  OUTCOME_NO_TOOL,
  OUTCOME_VERBS,
  POLICY_REFUSAL_OPENINGS,
  PROTOCOL_REFUSAL_OPENINGS,
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
  parseBrokerOutcomeLine,
  windowNanos,
} from "./github-publish-broker-soak-queries.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "adapter-utils", "src");

/**
 * Build an outcome line the way `formatBrokerOutcomeLine` does, from its
 * literal template. Every outcome fixture below goes through this, so a change
 * to that template breaks these tests rather than silently making them
 * fictional — which is exactly what went wrong with the refusal fixtures: they
 * were hand-copied UNPREFIXED while `PublishBrokerRefusal` prefixes every
 * message, so the suite was green against strings the broker never emits.
 */
function outcomeLine({ outcome, tool, code, detail }) {
  const parts = [`${SELF_PREFIX}${outcome} ${tool ?? OUTCOME_NO_TOOL} code=${code}`];
  if (detail !== undefined) parts.push(`detail=${detail}`);
  return parts.join(" ");
}

/** A refusal reason as `refuse` receives it — ALWAYS self-prefixed. */
const refusalReason = (prose) => `${SELF_PREFIX}${prose}`;

// Verbatim from the broker on `master` at the PEN-5185 merge (71d2d07e3). If a
// message is reworded these fixtures must be re-copied from source -- that is
// the point of them.
const LINES = {
  listening: `${SELF_PREFIX}listening on /run/paperclip/github-broker.sock, publishing from under /paperclip/work`,
  startupUnset: `${SELF_PREFIX}PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset; refusing to start without a workspace root to confine requests to`,
  startupOther: "listen EADDRINUSE: address already in use /run/paperclip/github-broker.sock",
  acceptGit: `${SELF_PREFIX}git in /paperclip/work/repo`,
  acceptGh: `${SELF_PREFIX}gh in /paperclip/work/repo`,
  acceptMcp: `${SELF_PREFIX}github-mcp-server in /paperclip/work/repo`,

  // (b) POLICY refusals -- a PublishBrokerRefusal, prefixed by its own
  // constructor and then carried inside the outcome line's `detail=`.
  refusalNotPush: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("the broker performs pushes, and this is `git status`. Everything git does that is not a publish runs locally in your own container — call it there."),
  }),
  refusalConfig: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("refusing a push that sets git config itself (`-c`). `credential.helper` is multi-valued"),
  }),
  refusalGhVerb: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason('refusing `gh auth`: it is a route from "the broker runs gh for me" back to holding the token itself'),
  }),
  refusalRelCwd: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("refusing a relative working directory `../elsewhere`"),
  }),
  refusalOutside: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("refusing a working directory outside the shared workspace: `/etc` resolves to `/etc`, which is not under `/paperclip/work`."),
  }),
  refusalArgPath: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("refusing an argument that names a file outside the shared workspace: `/etc/shadow` resolves to `/etc/shadow`."),
  }),

  // (b) PROTOCOL refusals -- the four sites that never touch the policy module
  // and were entirely dark before PEN-5185.
  protoFrameDeclares: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("frame declares 9999999 bytes, over the 1048576-byte cap"),
  }),
  protoSecondRequest: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("a second request on one connection; one publish per connection"),
  }),
  protoStdinEarly: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("stdin arrived before a request"),
  }),
  protoUnknownKind: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("unknown frame kind 0x7f"),
  }),

  // (b) the NON-refusal branch: an arbitrary Node/protocol error, refused.
  requestErrorParse: outcomeLine({
    outcome: "refused", tool: null, code: 64, detail: refusalReason("request is not valid JSON"),
  }),
  requestErrorUnknownTool: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason('unknown tool "curl"; expected one of git, gh, github-mcp-server'),
  }),
  requestErrorSpawn: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason("EACCES: permission denied, mkdir '/paperclip/work/repo/.git'"),
  }),

  // (c) and the denominator.
  exitOkGit: outcomeLine({ outcome: "exit", tool: "git", code: 0 }),
  exitOkGh: outcomeLine({ outcome: "exit", tool: "gh", code: 0 }),
  exitFailGh: outcomeLine({ outcome: "exit", tool: "gh", code: 7 }),
  exitFailSignal: outcomeLine({ outcome: "exit", tool: "git", code: 143 }),
  spawnFailed: outcomeLine({ outcome: "spawn-failed", tool: "gh", code: 1, detail: "ENOENT" }),

  // ⚠ Adversarial: the refusal reason ECHOES CALLER TEXT. `unknown tool
  // ${JSON.stringify(candidate.tool)}` reflects whatever JSON arrived, so a
  // caller can embed the literal `detail=<prefix>refusing ` inside its own
  // tool name. With an UNANCHORED `|~ detail=…` this matched policy_refusal
  // AND request_error_other in Loki while the classifier counted it once, so
  // the partition over-totalled and the report blamed a broken matcher.
  // Found by review on #3409.
  refusalEchoingDetail: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason(`unknown tool "detail=${SELF_PREFIX}refusing a thing"; expected one of git, gh, github-mcp-server`),
  }),
  // The protocol-opening spelling of the same trick.
  refusalEchoingProtocolDetail: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason(`unknown tool "detail=${SELF_PREFIX}stdin arrived before a request"; expected one of git, gh, github-mcp-server`),
  }),

  // Adversarial: a refusal whose agent-supplied value quotes a prefixed shape.
  // classifyBrokerLine anchors, so these stay refusals; an UNANCHORED
  // contains-matcher would miscount them as startup or accept lines.
  refusalQuotingListen: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason(`refusing a relative working directory \`${SELF_PREFIX}${SELF_LISTEN} /x\``),
  }),
  refusalQuotingUnset: outcomeLine({
    outcome: "refused", tool: null, code: 64,
    detail: refusalReason(`refusing a relative working directory \`${SELF_PREFIX}${SELF_WORKSPACE_UNSET}\``),
  }),
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

  it("counts category (c) — the whole point of PEN-5185", () => {
    // Before PEN-5185 `sendExit` framed the exit code to the SOCKET and nothing
    // wrote it to stderr, so this category printed NOT OBSERVABLE. Before item
    // 6 the lines existed but landed in `request_error_other`.
    assert.equal(classifyBrokerLine(LINES.exitFailGh), "child_nonzero_exit");
    assert.equal(classifyBrokerLine(LINES.exitFailSignal), "child_nonzero_exit");
  });

  it("does NOT count a successful publish as a failure or a rejection", () => {
    // The regression item 6 exists to fix: every outcome line, including
    // `exit git code=0`, fell through to `request_error_other`, whose label
    // reads "request rejected". A clean soak reported as all-rejections AND
    // the partition still balanced, so nothing warned.
    for (const k of ["exitOkGit", "exitOkGh"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "child_exit_ok", k);
    }
  });

  it("gives a spawn failure its own class, not `exit 1`", () => {
    // The tool never ran. Folding it into (c) would overstate child failures
    // and hide a class §5.3 did not name at all.
    assert.equal(classifyBrokerLine(LINES.spawnFailed), "spawn_failed");
  });

  it("separates a POLICY refusal from a PROTOCOL refusal, which the code cannot", () => {
    // Both exit 64. The reason is the only discriminator, and the distinction
    // is security-relevant: an attempted egress bypass vs a client stutter.
    for (const k of ["protoFrameDeclares", "protoSecondRequest", "protoStdinEarly", "protoUnknownKind"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "protocol_refusal", k);
    }
    for (const k of ["refusalNotPush", "refusalConfig", "refusalGhVerb", "refusalRelCwd", "refusalOutside", "refusalArgPath"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "policy_refusal", k);
    }
    // Same verb, same code, different category — stated outright.
    for (const k of [...["refusalNotPush", "refusalConfig", "refusalGhVerb", "refusalRelCwd", "refusalOutside", "refusalArgPath"], ...["protoFrameDeclares", "protoSecondRequest", "protoStdinEarly", "protoUnknownKind"]]) {
      const parsed = parseBrokerOutcomeLine(LINES[k].slice(SELF_PREFIX.length));
      assert.equal(parsed.outcome, "refused", k);
      assert.equal(parsed.code, 64, k);
    }
  });

  it("counts the non-refusal request error under (b), as the residual", () => {
    for (const k of ["requestErrorParse", "requestErrorUnknownTool", "requestErrorSpawn"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "request_error_other", k);
    }
  });

  it("does not let an echoed `detail=` in the reason forge an attributed refusal", () => {
    // The reason is caller-echoed text. Anchoring is what stops the echo from
    // being read as the real `detail=` field — in the classifier AND in the
    // shipped LogQL, which must agree. The agreement test below is what
    // actually catches the Loki side; this pins the classifier's half.
    for (const k of ["refusalEchoingDetail", "refusalEchoingProtocolDetail"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "request_error_other", k);
    }
  });

  it("derives the policy openings from policy.ts, so they cannot be hand-copied wrong", () => {
    // The #3205 finding generalised. The shipped fixtures used to be
    // UNPREFIXED refusals, which PublishBrokerRefusal never produces, so the
    // suite was green against strings the broker cannot emit and the shipped
    // query matched nothing in production.
    const src = readFileSync(join(SRC, "github-publish-broker-policy.ts"), "utf8");
    const ctor = /super\(message\.startsWith\("paperclip-github-broker"\) \? message : `paperclip-github-broker: \$\{message\}`\)/;
    assert.match(src, ctor, "PublishBrokerRefusal no longer prefixes — every refusal matcher must be re-derived");

    // Every refusal message in policy.ts must open with a known opening.
    const messages = [...src.matchAll(/new PublishBrokerRefusal\(\s*(`|")([\s\S]{0,80})/g)].map((m) => m[2]);
    assert.ok(messages.length >= 9, `expected policy.ts refusals, found ${messages.length}`);
    for (const msg of messages) {
      assert.ok(
        POLICY_REFUSAL_OPENINGS.some((o) => msg.startsWith(o)),
        `policy.ts refusal opens with an unknown phrase, so policy_refusal would miss it:\n  ${msg}`,
      );
    }
  });

  it("derives the protocol openings from broker.ts, so a fifth site cannot go dark", () => {
    const src = readFileSync(join(SRC, "github-publish-broker.ts"), "utf8");
    // The literal protocol refusals. The variable one (`frame declares`) comes
    // from createFrameReader and is asserted against protocol.ts below.
    for (const opening of ["a second request on one connection", "stdin arrived before a request", "unknown frame kind 0x"]) {
      assert.ok(src.includes(opening), `broker.ts no longer writes ${JSON.stringify(opening)}`);
      assert.ok(PROTOCOL_REFUSAL_OPENINGS.includes(opening), `${opening} missing from PROTOCOL_REFUSAL_OPENINGS`);
    }
    const proto = readFileSync(join(SRC, "github-publish-broker-protocol.ts"), "utf8");
    assert.ok(proto.includes("frame declares "), "createFrameReader no longer says `frame declares`");
  });

  it("mirrors the broker's outcome verbs exactly", () => {
    const src = readFileSync(join(SRC, "github-publish-broker.ts"), "utf8");
    for (const verb of OUTCOME_VERBS) {
      assert.ok(src.includes(`| "${verb}"`) || src.includes(`"${verb}"`), `broker.ts no longer knows verb ${verb}`);
    }
    assert.deepEqual(OUTCOME_VERBS, ["exit", "spawn-failed", "refused"]);
  });

  it("covers every brokered tool, so a fourth door cannot be added silently", () => {
    assert.deepEqual(BROKERED_TOOLS, ["git", "gh", "github-mcp-server"]);
    for (const tool of BROKERED_TOOLS) {
      assert.equal(classifyBrokerLine(`${SELF_PREFIX}${tool} in /paperclip/work/x`), "invocation_accepted");
      assert.equal(classifyBrokerLine(`${SELF_PREFIX}exit ${tool} code=0`), "child_exit_ok");
      assert.equal(classifyBrokerLine(`${SELF_PREFIX}exit ${tool} code=3`), "child_nonzero_exit");
    }
  });

  it("does not mistake a self-prefixed novelty for a startup failure", () => {
    assert.equal(classifyBrokerLine(`${SELF_PREFIX}something nobody has written yet`), "request_error_other");
  });

  it("does not mistake a prefixed line that merely starts with a verb for an outcome", () => {
    // `parseBrokerOutcomeLine` checks the TOOL against BROKERED_TOOLS, so prose
    // beginning "exit ..." cannot score as a child exit.
    assert.equal(classifyBrokerLine(`${SELF_PREFIX}exit the building code=0`), "request_error_other");
    assert.equal(classifyBrokerLine(`${SELF_PREFIX}refused to elaborate`), "request_error_other");
    assert.equal(parseBrokerOutcomeLine("exit curl code=0"), null);
    assert.equal(parseBrokerOutcomeLine("sauntered-off gh code=0"), null);
  });

  it("reads an adversarial refusal that quotes a prefixed shape as a refusal", () => {
    for (const k of ["refusalQuotingListen", "refusalQuotingUnset"]) {
      assert.equal(classifyBrokerLine(LINES[k]), "policy_refusal", k);
    }
  });

  it("keeps the vestigial unprefixed-refusal branch, which fails safe", () => {
    // Refusals are no longer unprefixed — they travel inside `detail=`. The
    // branch is kept so a refusal reaching stderr unwrapped is still counted
    // as a refusal rather than as an unexpected startup error.
    for (const opening of POLICY_REFUSAL_OPENINGS) {
      assert.equal(classifyBrokerLine(`${opening}whatever`), "policy_refusal");
    }
    assert.equal(REFUSAL_OPENINGS, POLICY_REFUSAL_OPENINGS, "back-compat alias must not drift");
  });

  it("handles empty and nullish input without throwing", () => {
    assert.equal(classifyBrokerLine(""), "startup_failure_other");
    assert.equal(classifyBrokerLine(undefined), "startup_failure_other");
    assert.equal(parseBrokerOutcomeLine(undefined), null);
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

describe("the §5.3 categories are counted, and the one dark class stays dark", () => {
  it("counts child non-zero exits — category (c), the row's reason for existing", () => {
    const q = BROKER_QUERIES.find((x) => x.id === "child_nonzero_exit");
    assert.equal(q.category, "c");
    assert.equal(q.observable, true, "sendExit logs through ctx.log since PEN-5185");
  });

  it("counts protocol refusals and spawn failures, which were entirely dark", () => {
    assert.equal(BROKER_QUERIES.find((x) => x.id === "protocol_refusal").observable, true);
    const spawn = BROKER_QUERIES.find((x) => x.id === "spawn_failed");
    assert.ok(spawn, "spawn failure has no query — §5.3 did not name the class, so it must be named here");
    assert.equal(spawn.observable, true);
  });

  it("keeps NOT OBSERVABLE available, so a future dark category cannot print 0", () => {
    // Every category is observable TODAY. The mechanism is the thing being
    // retained, per done-when 6: the next class the broker cannot emit must
    // still be able to say so rather than report a false all-clear.
    const out = formatReport(
      [{ id: "z", category: "c", label: "something dark", observable: false, count: null }],
      { window: "24h", streamTotal: 1, newest: "2026-11-05T09:00:00.000Z" },
    );
    assert.match(out, /something dark\s+NOT OBSERVABLE/);
    assert.doesNotMatch(out, /something dark\s+0/);
  });

  it("⛔ ships NO query for the child's own stderr, and must never", () => {
    // The one way to get PEN-5185 wrong. child.stderr is git/gh output and can
    // carry a push URL with an embedded token; the broker's stderr reaches
    // Loki, which outlives ttlSecondsAfterFinished: 300. A query here would
    // mean someone had teed it into the container log.
    for (const q of BROKER_QUERIES) {
      assert.ok(!/child[_ ]?stderr/i.test(q.id + q.label + q.note), `${q.id} looks like a child-stderr query`);
    }
    const src = readFileSync(join(SRC, "github-publish-broker.ts"), "utf8");
    const relay = /child\.stderr\?\.on\("data", \(data: Buffer\) => socket\.write\(/;
    assert.match(src, relay, "child.stderr must be relayed to the SOCKET only");
    assert.ok(
      !/child\.stderr[\s\S]{0,200}ctx\.log/.test(src),
      "child.stderr is being written to the container log — this is the credential-disclosure path §5.3 forbids",
    );
  });

  it("counts the non-refusal request error under (b), observably", () => {
    const q = BROKER_QUERIES.find((x) => x.id === "request_error_other");
    assert.equal(q.category, "b", "a rejected request is a (b) event, not a startup failure");
    assert.equal(q.observable, true);
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

describe("accept and outcome counts are compared, as §5.3 promises a reader", () => {
  const row = (id, count) => ({ id, category: "x", label: id, observable: true, count });
  const base = (accepted, ok, bad, spawn) => [
    row("invocation_accepted", accepted),
    row("child_exit_ok", ok),
    row("child_nonzero_exit", bad),
    row("spawn_failed", spawn),
  ];

  it("stays quiet when every accepted publish reported an outcome", () => {
    const out = formatReport(base(5, 3, 1, 1), { window: "24h", streamTotal: 10, newest: "x" });
    assert.doesNotMatch(out, /imbalance/);
  });

  it("reports a dropped outcome line as an imbalance, not as a miscount", () => {
    // §5.3: the outcome log is best-effort (a throw must not kill the sidecar),
    // so this is the reader's signal that a line went missing.
    const out = formatReport(base(5, 2, 1, 0), { window: "24h", streamTotal: 10, newest: "x" });
    assert.match(out, /accept\/outcome imbalance: 5 accepted, 3 outcome line\(s\)/);
    assert.match(out, /2 accepted publish\(es\) reported no outcome/);
  });

  it("reports a surplus of outcomes differently from a shortfall", () => {
    const out = formatReport(base(1, 2, 1, 0), { window: "24h", streamTotal: 10, newest: "x" });
    assert.match(out, /2 more outcome\(s\) than accepts/);
  });

  it("does not count a refusal as an outcome of an accepted publish", () => {
    // A refused request never reached startChild, so it has no accept line.
    // Counting it here would mask a genuinely dropped outcome.
    const rows = [...base(2, 2, 0, 0), row("policy_refusal", 7), row("protocol_refusal", 3)];
    const out = formatReport(rows, { window: "24h", streamTotal: 14, newest: "x" });
    assert.doesNotMatch(out, /imbalance/);
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
