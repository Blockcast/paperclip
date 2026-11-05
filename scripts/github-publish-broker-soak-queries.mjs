// PEN-5181 / PEN-5016 §5.3: the saved broker log queries, as code.
//
// §5.3 of docs/security/PEN-5016-github-publish-broker-enablement-plan.md asks
// stage 0 to produce "a saved query over
// {namespace="paperclip",container="github-publish-broker"} separating
// (a) startup failures, (b) policy refusals, (c) child non-zero exits", and
// says plainly why: "Without it stage 1 is unfalsifiable -- a silent broker and
// a broker nobody asked to publish look identical."
//
// ## Why a script and not a Grafana dashboard
//
// Paperclip dashboards ARE dashboard-as-code (runbooks/grafana-dashboard-as-code.md)
// and that was the first thing tried. Three things rule it out as the PRIMARY
// artifact here, and none of them is a matter of taste:
//
//   1. Those dashboards are Prometheus-backed. `grafanaDashboard.datasourceUid`
//      defaults to `cluster`, documented in values.yaml as "Must be a Prometheus
//      that scrapes the paperclip control plane". These are LogQL queries. No
//      Loki datasource uid is recorded anywhere in this repo, and the Grafana
//      that would hold it (orc8r-user-grafana, ns/production-orc8r) is not
//      readable from an agent seat -- so a dashboard would ship pointing at a
//      uid nobody verified, and a wrong datasource renders "No data" while
//      looking healthy in review. That is listed as a known trap in that very
//      runbook.
//   2. `grafanaDashboard.enabled` defaults false, and dashboards reach the
//      cluster only through the paperclip-api deploy pipeline, which is a
//      MANUAL human-dispatched deploy (BLO-22032) that has repeatedly run
//      hundreds of commits behind. "Merged" and "live" are different states.
//      Stage 0 is dated 2026-11-05 and stage 1 can start the next working day.
//   3. Agent Jobs carry `ttlSecondsAfterFinished: 300`, so §5.3 requires
//      evidence collected INSIDE the window. A query you can run right now from
//      any agent pod or ARC runner, with no credential and no deploy, is worth
//      more here than one that is live after the next release.
//
// A dashboard is still worth having on top. It is not what makes stage 1
// falsifiable by 2026-11-06.
//
// ## What the broker emits, and the one thing it deliberately does not
//
// Read before trusting any output. This section was rewritten by PEN-5185
// item 6; the state it describes is `master` at the PEN-5185 merge
// (71d2d07e3). ⚠ Anchors are SYMBOLS, not line numbers — this comment cited
// `:271,329,419`, which rotted to `:278,366,417` and then moved again when
// PEN-5185 landed. Grep the symbol (PEN-5091).
//
// Until PEN-5185 the broker reported every publish OUTCOME to the socket — back
// to the agent — and wrote only its INPUTS to its own stderr. Three classes
// were therefore structurally unobservable rather than merely quiet, and this
// script printed NOT OBSERVABLE for them rather than `0`, because `0` and "no
// child ever failed" are byte-identical and that is the exact confusion §5.3
// exists to prevent. `sendExit` and `refuse` now log through ONE chokepoint,
// so those categories are real counts and the NOT OBSERVABLE stopgap is
// retired for them.
//
// Two line families reach the container stderr, and the split is load-bearing:
//
//   - INPUT lines, one per accepted invocation — `${tool} in ${cwd}` from
//     `startChild`. This is the denominator.
//   - OUTCOME lines, exactly one per connection, from `formatBrokerOutcomeLine`
//     via `sendExit`:
//
//         paperclip-github-broker: <verb> <tool|-> code=<n> [detail=<reason>]
//
//     with `<verb>` drawn from the closed set OUTCOME_VERBS. ⛔ The VERB, not
//     the code, separates a refusal from a child exit: `refuse` defaults to 64
//     and a child can genuinely return 64.
//
// Plus the two startup lines from `main()` in github-publish-broker-runtime.ts.
//
// ## ⛔ The child's bytes are NOT here, and must never be
//
// `child.stderr` is relayed to the SOCKET and nowhere else. It is `git`/`gh`
// output and can carry a URL with an embedded token; the broker's stderr
// reaches Loki, which outlives the pod's `ttlSecondsAfterFinished: 300`. So
// teeing it into the container log would convert this observability surface
// into a durable credential-disclosure path. The outcome line carries the exit
// code and the tool name. A refusal also carries its own prose reason —
// the broker's words, not the child's — scrubbed through
// `scrubGitHubEgressText` and capped at 1024 chars.
//
// That is the one category still dark, and it is dark ON PURPOSE: there is no
// `child_stderr` query here and there must not be one.
//
// ## How a refusal is attributed, and why it is the detail and not the code
//
// All five `refuse()` call sites now log. Four never touched the policy module
// and were invisible before PEN-5185. They are told apart by the REASON, which
// is the only thing that differs — every one of them exits 64:
//
//   - a reason opening with a POLICY_REFUSAL_OPENING is a policy refusal, i.e.
//     an attempted egress-policy bypass. This is the single most
//     security-relevant thing the broker can report.
//   - a reason opening with a PROTOCOL_REFUSAL_OPENING is a malformed or
//     out-of-sequence frame — a client stutter, not a bypass attempt.
//   - anything else is a rejected request whose cause is an arbitrary Node
//     error (a bad JSON body, a workspace-prep failure in `startChild`), and
//     is the residual bucket AND the novelty signal.
//
// ⚠ `PublishBrokerRefusal`'s constructor prefixes EVERY message with
// `paperclip-github-broker: `, and has since the broker's first commit
// (ff160679d). So the openings below are the prose AFTER that prefix, and a
// matcher anchored on the bare prose matches nothing. That mistake shipped
// once: the pre-PEN-5185 `policy_refusal` query was anchored unprefixed and
// returned 0 for every window, which then surfaced through the partition check
// as "a new log line has been added". The test derives these openings from
// github-publish-broker-policy.ts rather than restating them.
//
// Usage:
//   node scripts/github-publish-broker-soak-queries.mjs [--window 24h] [--json]
//   PAPERCLIP_LOKI_URL=http://loki.monitoring.svc.cluster.local:3100

export const LOKI_BASE_URL = process.env.PAPERCLIP_LOKI_URL ?? "http://loki.monitoring.svc.cluster.local:3100";

/** Must stay in step with GITHUB_BROKER_CONTAINER_NAME (job-manifest.ts:2776). */
export const BROKER_CONTAINER = "github-publish-broker";
export const BROKER_STREAM = `{namespace="paperclip",container="${BROKER_CONTAINER}"}`;

/** Mirrors BROKERED_TOOLS in packages/adapter-utils/src/github-publish-broker-protocol.ts. */
export const BROKERED_TOOLS = ["git", "gh", "github-mcp-server"];

/** Prefix every line the broker writes about itself carries. */
export const SELF_PREFIX = "paperclip-github-broker: ";

/**
 * Openings of every `PublishBrokerRefusal` message in
 * github-publish-broker-policy.ts, as the prose AFTER the self prefix.
 *
 * ⚠ These do NOT appear at the start of a log line. `PublishBrokerRefusal`
 * prefixes every message, and `refuse` now routes the message into the outcome
 * line's `detail=`, so a policy refusal reaches Loki as:
 *
 *   paperclip-github-broker: refused - code=64 detail=paperclip-github-broker: refusing ...
 *
 * A matcher anchored on the bare prose matches nothing — see the header.
 */
export const POLICY_REFUSAL_OPENINGS = ["refusing ", "the broker performs pushes, and this is "];

/**
 * Back-compat alias. The pre-PEN-5185 name, kept because it is accurate and
 * because #3205 is still open against the old spelling; prefer the explicit
 * POLICY_REFUSAL_OPENINGS in new code, which does not read as "all refusals".
 */
export const REFUSAL_OPENINGS = POLICY_REFUSAL_OPENINGS;

/**
 * Openings of the four protocol-level `refuse()` messages in
 * github-publish-broker.ts — the sites that never touch the policy module and
 * were entirely invisible before PEN-5185. Also prose after the self prefix.
 *
 * `frame declares ` is the `createFrameReader` throw caught by the
 * `socket.on("data")` handler; the other three are literal.
 *
 * ⛔ Keeping these separate from the policy openings is the point of the
 * category, not decoration: "stdin arrived before a request" is a client
 * stutter and "refusing `gh auth`" is an attempted credential exfiltration.
 * A single `refused` count cannot tell an operator which one happened, and
 * they exit with the same code.
 */
export const PROTOCOL_REFUSAL_OPENINGS = [
  "frame declares ",
  "a second request on one connection",
  "stdin arrived before a request",
  "unknown frame kind 0x",
];

/**
 * The closed set of outcome verbs, mirroring `PublishBrokerOutcome` in
 * packages/adapter-utils/src/github-publish-broker.ts.
 */
export const OUTCOME_VERBS = ["exit", "spawn-failed", "refused"];

/**
 * `formatBrokerOutcomeLine` writes `-` for the tool when the connection was
 * refused before a request was parsed — there is no tool, and naming one would
 * invent a door that was never asked for.
 */
export const OUTCOME_NO_TOOL = "-";

export const SELF_LISTEN = "listening on";
export const SELF_WORKSPACE_UNSET = "PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset";

/**
 * Every prefixed shape the broker is KNOWN to write, as LogQL alternation
 * fragments. `request_error_other` is defined as the complement of this list
 * within the prefixed family, so this is the single place the two must agree.
 */
const KNOWN_SELF_SHAPES = [
  escapeForLogqlRegex(SELF_LISTEN),
  escapeForLogqlRegex(SELF_WORKSPACE_UNSET),
  `(${BROKERED_TOOLS.map(escapeForLogqlRegex).join("|")}) in /`,
];

/** `git|gh|github-mcp-server|-` — the tool field of an outcome line. */
const OUTCOME_TOOL_ALT = [...BROKERED_TOOLS, OUTCOME_NO_TOOL].map(escapeForLogqlRegex).join("|");

/**
 * The refusal reasons that ARE attributed to a named family. `request_error_other`
 * is the complement of this within `refused`, so this is the single place the
 * two must agree.
 */
const ATTRIBUTED_REFUSAL_ALT = [...POLICY_REFUSAL_OPENINGS, ...PROTOCOL_REFUSAL_OPENINGS]
  .map(escapeForLogqlRegex)
  .join("|");

/**
 * A complete outcome head, used as an EXCLUSION so that prefixed prose merely
 * beginning with a verb (`exit the building`) is not mistaken for one — which
 * is exactly how `parseBrokerOutcomeLine` decides.
 */
const OUTCOME_HEAD = `(${OUTCOME_VERBS.map(escapeForLogqlRegex).join("|")}) (${OUTCOME_TOOL_ALT}) code=[0-9]+`;

/**
 * The saved query set. `observable: false` entries are the §5.3 categories the
 * broker cannot currently emit -- they are kept here, with the query that would
 * work, so the gap travels with the tooling.
 */
export const BROKER_QUERIES = [
  {
    id: "startup_listening",
    category: "a",
    label: "startup OK (broker reached listen)",
    observable: true,
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX + SELF_LISTEN)}\``,
    note: "runtime.ts:39. The denominator for (a): a brokered pod with no listen line did not start.",
  },
  {
    id: "startup_failure_workspace_root",
    category: "a",
    label: "startup FAILURE (workspace root unset)",
    observable: true,
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX + SELF_WORKSPACE_UNSET)}\``,
    note: "runtime.ts:33 throw, surfaced by :55. The only named startup failure.",
  },
  {
    id: "startup_failure_other",
    category: "a",
    label: "startup FAILURE (unexpected — unprefixed error)",
    observable: true,
    // runtime.ts:55 writes a raw `error.message` for anything createPublishBrokerServer
    // throws (EADDRINUSE on a stale socket, mkdir failure, ...). Those are Node
    // messages and carry no prefix, and refusals are the only other unprefixed
    // lines -- hence both exclusions. Both are ANCHORED and case-SENSITIVE so
    // this matcher mirrors classifyBrokerLine's startsWith exactly; an
    // unanchored `!=` excluded a line merely CONTAINING the prefix, which the
    // classifier counts here.
    logql: `${BROKER_STREAM} !~ \`^${escapeForLogqlRegex(SELF_PREFIX)}\` !~ \`^(${REFUSAL_OPENINGS.map(escapeForLogqlRegex).join("|")})\``,
    note: "runtime.ts:55. Residual bucket: unprefixed and not a refusal ⇒ an unnamed startup error.",
  },
  {
    id: "policy_refusal",
    category: "b",
    label: "policy refusal (attempted egress-policy bypass)",
    observable: true,
    // `refuse` -> `sendExit(code, "refused", message)`. The reason is the
    // discriminator, and it is DOUBLY prefixed: the outcome line carries the
    // self prefix, and PublishBrokerRefusal already prefixed the message.
    logql:
      `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}refused \`` +
      ` |~ \`detail=${escapeForLogqlRegex(SELF_PREFIX)}(${POLICY_REFUSAL_OPENINGS.map(escapeForLogqlRegex).join("|")})\``,
    note:
      "A PublishBrokerRefusal from github-publish-broker-policy.ts. ⚠ The security-relevant " +
      "category: this is the boundary refusing an attempt to reach the credential. Investigate " +
      "every one — unlike a protocol refusal, it is never a client bug.",
  },
  {
    id: "protocol_refusal",
    category: "b",
    label: "protocol refusal (malformed frame / bad sequence)",
    observable: true,
    // The four non-policy `refuse()` sites. Invisible before PEN-5185.
    logql:
      `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}refused \`` +
      ` |~ \`detail=${escapeForLogqlRegex(SELF_PREFIX)}(${PROTOCOL_REFUSAL_OPENINGS.map(escapeForLogqlRegex).join("|")})\``,
    note:
      "A malformed or out-of-sequence frame. Ordinarily a client bug, not an attack — but it " +
      "exits 64 exactly like a policy refusal, which is why the verb and reason, not the code, " +
      "carry the distinction.",
  },
  {
    id: "request_error_other",
    category: "b",
    label: "request rejected (unexpected error — neither policy nor protocol)",
    observable: true,
    // The non-refusal branch: whatever `parsePublishBrokerRequest` or
    // `startChild` threw that was not a PublishBrokerRefusal — a bad JSON
    // body, an unknown tool, a workspace-prep failure. Arbitrary Node strings
    // with no fixed shape, so this is the COMPLEMENT of the two named refusal
    // families within `refused`.
    // ⚠ A COMPLEMENT, not a pattern. It must absorb BOTH an unattributed
    // refusal reason AND a prefixed line nobody has written yet, or the
    // partition stops being total and the report's shortfall check — which
    // reads a gap as a broken matcher — starts lying about which it is.
    logql:
      `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}\`` +
      ` !~ \`^${escapeForLogqlRegex(SELF_PREFIX)}(${KNOWN_SELF_SHAPES.join("|")})\`` +
      ` !~ \`^${escapeForLogqlRegex(SELF_PREFIX)}(${escapeForLogqlRegex("exit")}|${escapeForLogqlRegex("spawn-failed")}) (${OUTCOME_TOOL_ALT}) code=[0-9]+\`` +
      ` !~ \`^${escapeForLogqlRegex(SELF_PREFIX)}refused (${OUTCOME_TOOL_ALT}) code=[0-9]+ detail=${escapeForLogqlRegex(SELF_PREFIX)}(${ATTRIBUTED_REFUSAL_ALT})\``,
    note:
      "⚠ This is ALSO where a newly added refusal reason would land, so this count is the " +
      "novelty signal. If it moves and no publish was rejected, re-read the refusal sites. " +
      "Before PEN-5185 item 6 this bucket silently absorbed EVERY outcome line, including " +
      "successful publishes — a clean soak read as all-rejections and the partition still balanced.",
  },
  {
    id: "invocation_accepted",
    category: "denominator",
    label: "invocations accepted (publish attempts)",
    observable: true,
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}(${BROKERED_TOOLS.map(escapeForLogqlRegex).join("|")}) in /\``,
    note:
      "`ctx.log` in `startChild`. Per-door publish attempts. Compare against the outcome total: " +
      "the two must agree, and §5.3 says so — a dropped outcome line shows up as an IMBALANCE " +
      "here rather than as a miscount inside a category.",
  },
  {
    id: "child_exit_ok",
    category: "denominator",
    label: "child exited 0 (publish succeeded)",
    observable: true,
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}exit (${[...BROKERED_TOOLS, OUTCOME_NO_TOOL].map(escapeForLogqlRegex).join("|")}) code=0($| )\``,
    note:
      "The success case, counted so the outcome families sum to the accept count. Anchored on " +
      "`code=0$` because an `exit` line carries no detail — `child.on(\"close\")` passes none.",
  },
  {
    id: "child_nonzero_exit",
    category: "c",
    label: "child non-zero exits",
    observable: true,
    // §5.3's category (c). Observable since PEN-5185; this printed NOT
    // OBSERVABLE before, because `sendExit` framed the code to the socket only.
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}exit (${[...BROKERED_TOOLS, OUTCOME_NO_TOOL].map(escapeForLogqlRegex).join("|")}) code=[1-9][0-9]*($| )\``,
    note:
      "The tool RAN and failed. `code` is the child's own status (or 128+n for a signal). " +
      "⛔ The child's stderr explaining WHY is socket-only and must stay that way — it can carry " +
      "a push URL with an embedded token. Read the agent's run log for the reason.",
  },
  {
    id: "spawn_failed",
    category: "c",
    label: "spawn failures (the tool never started)",
    observable: true,
    // `child.on("error")`. §5.3 did not name this class at all before PEN-5185.
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}spawn-failed \``,
    note:
      "exec failed — the tool did NO work. Its own verb rather than an `exit` of 1, because " +
      "counting it under (c) would overstate child failures and hide a class with a different " +
      "cause (a missing binary, a broken image) and a different fix.",
  },
];

/** LogQL backtick-quoted strings take no escapes, so a backtick cannot appear. */
export function escapeForLogqlRegex(literal) {
  if (literal.includes("`")) throw new Error(`backtick in LogQL literal: ${literal}`);
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildCountQuery(logql, window) {
  assertWindow(window);
  return `sum(count_over_time(${logql} [${window}]))`;
}

export function assertWindow(window) {
  if (!/^\d+[smhdw]$/.test(String(window ?? ""))) {
    throw new Error(`invalid Loki window ${JSON.stringify(window)}; expected e.g. 30m, 24h, 7d`);
  }
  return window;
}

/**
 * Split an outcome line's body (everything after SELF_PREFIX) into its fields,
 * or return `null` if it is not an outcome line at all.
 *
 * `formatBrokerOutcomeLine` writes exactly:
 *
 *   <verb> <tool|-> code=<n>[ detail=<reason>]
 *
 * The tool is checked against BROKERED_TOOLS rather than matched as `\S+`, so
 * a future prefixed line that merely begins with one of the verbs cannot be
 * mistaken for an outcome. `detail` is already collapsed to one physical line
 * by the broker, so there is nothing multi-line to handle here.
 */
export function parseBrokerOutcomeLine(body) {
  const m = /^(\S+) (\S+) code=(\d+)(?: detail=(.*))?$/.exec(String(body ?? ""));
  if (!m) return null;
  const [, outcome, tool, code, detail] = m;
  if (!OUTCOME_VERBS.includes(outcome)) return null;
  if (tool !== OUTCOME_NO_TOOL && !BROKERED_TOOLS.includes(tool)) return null;
  return { outcome, tool: tool === OUTCOME_NO_TOOL ? null : tool, code: Number(code), detail: detail ?? null };
}

/**
 * Partition one broker stderr line. Pure, and the reason the query set can be
 * trusted: the queries above and this function must agree, which the tests
 * assert line-by-line against strings taken from the broker source.
 *
 * Every branch returns a category, so this is a TOTAL partition: a line that
 * matches nothing is impossible by construction, which is what lets the report
 * read a shortfall as a broken matcher rather than as a new log shape.
 */
export function classifyBrokerLine(line) {
  const text = String(line ?? "");
  if (text.startsWith(SELF_PREFIX)) {
    const rest = text.slice(SELF_PREFIX.length);
    if (rest.startsWith(SELF_LISTEN)) return "startup_listening";
    if (rest.startsWith(SELF_WORKSPACE_UNSET)) return "startup_failure_workspace_root";
    for (const tool of BROKERED_TOOLS) {
      if (rest.startsWith(`${tool} in /`)) return "invocation_accepted";
    }
    const outcome = parseBrokerOutcomeLine(rest);
    if (outcome) {
      if (outcome.outcome === "spawn-failed") return "spawn_failed";
      if (outcome.outcome === "exit") return outcome.code === 0 ? "child_exit_ok" : "child_nonzero_exit";
      // `refused`. The reason tells a bypass attempt from a client stutter;
      // the code cannot, because both are 64.
      const reason = (outcome.detail ?? "").startsWith(SELF_PREFIX)
        ? outcome.detail.slice(SELF_PREFIX.length)
        : (outcome.detail ?? "");
      if (POLICY_REFUSAL_OPENINGS.some((o) => reason.startsWith(o))) return "policy_refusal";
      if (PROTOCOL_REFUSAL_OPENINGS.some((o) => reason.startsWith(o))) return "protocol_refusal";
      return "request_error_other";
    }
    // A prefixed line that is neither a known input shape nor a parseable
    // outcome. Genuinely novel, and counted rather than dropped.
    return "request_error_other";
  }
  // Unprefixed. Refusals are NOT unprefixed — PublishBrokerRefusal prefixes
  // them and they now travel inside `detail=` — so this is a raw Node error
  // from the runtime's startup catch. The exclusion below is vestigial and
  // kept deliberately: it costs one comparison and it fails safe if a refusal
  // ever reaches stderr unwrapped.
  for (const opening of POLICY_REFUSAL_OPENINGS) {
    if (text.startsWith(opening)) return "policy_refusal";
  }
  return "startup_failure_other";
}

export function parseArgs(argv) {
  const args = { window: "24h", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--window") args.window = argv[(i += 1)];
    else if (a.startsWith("--window=")) args.window = a.slice("--window=".length);
    else throw new Error(`unknown argument ${a}`);
  }
  assertWindow(args.window);
  return args;
}

export function formatReport(rows, { window, streamTotal, newest }) {
  const out = [];
  out.push(`broker soak queries — ${BROKER_STREAM} — window ${window}`);
  out.push("");
  // Width is computed, not a literal: a label longer than a hardcoded pad
  // silently breaks the column alignment of every row below it.
  const labelWidth = rows.reduce((w, r) => Math.max(w, r.label.length), 0);
  for (const r of rows) {
    const value = r.observable ? String(r.count) : "NOT OBSERVABLE";
    const tag = `[${r.category}]`.padEnd(14);
    out.push(`  ${tag} ${r.label.padEnd(labelWidth)} ${value.padStart(15)}`);
  }
  out.push("");
  // The liveness control. §5.3's whole point is that silence and absence are
  // byte-identical, so a zero is only meaningful beside proof the stream exists.
  out.push(`  stream total lines in window: ${streamTotal}`);
  out.push(`  newest entry: ${newest ?? "(none — stream has no data in window)"}`);
  if (streamTotal === 0) {
    out.push("");
    out.push("  ⚠ The broker stream is EMPTY for this window. Every zero above is");
    out.push("    'no broker pod has run', NOT 'the broker ran cleanly'. Expected");
    out.push("    while enableGitHubPublishBroker is off.");
  }
  // §5.3's accept-vs-outcome comparison. The outcome log is BEST-EFFORT: a
  // throw from `ctx.log` is swallowed so it cannot kill the sidecar, which
  // means a line can go missing. §5.3 tells the reader what that looks like —
  // "an imbalance between the accept count and the outcome count, not a
  // miscount inside a category" — so the tool has to compute it rather than
  // leave it to whoever remembers the sentence.
  //
  // Every accepted invocation ends in exactly one of: exit 0, exit non-zero,
  // spawn-failed. A refusal is NOT in that sum: a request refused by policy
  // never reached `startChild` and so was never accepted.
  const countOf = (id) => rows.find((r) => r.id === id)?.count ?? 0;
  const accepted = countOf("invocation_accepted");
  const outcomes = countOf("child_exit_ok") + countOf("child_nonzero_exit") + countOf("spawn_failed");
  if (accepted !== outcomes) {
    const missing = accepted - outcomes;
    out.push("");
    out.push(`  \u26a0 accept/outcome imbalance: ${accepted} accepted, ${outcomes} outcome line(s).`);
    if (missing > 0) {
      out.push(`    ${missing} accepted publish(es) reported no outcome. Either the outcome log`);
      out.push("    call threw (it is deliberately best-effort, §5.3), or the broker process died");
      out.push("    mid-publish — which is the §6 'a Job that never renders' shape. Check for a");
      out.push("    listen line with no matching shutdown before reading any count below as whole.");
    } else {
      out.push(`    ${-missing} more outcome(s) than accepts. An outcome without an accept is a`);
      out.push("    refusal miscounted as a child exit, or a window boundary cutting a publish in");
      out.push("    half. Re-run with a wider --window before investigating.");
    }
  }
  const classified = rows.filter((r) => r.observable).reduce((n, r) => n + r.count, 0);
  if (streamTotal > 0 && classified !== streamTotal) {
    out.push("");
    out.push(`  ⚠ ${streamTotal - classified} line(s) matched no category — the partition is incomplete.`);
    out.push("    The categories are a TOTAL partition by construction, so this does not mean a");
    out.push("    new log line was added: a new prefixed line is counted as 'request rejected");
    out.push("    (unexpected error)' and a new unprefixed one as 'startup FAILURE (unexpected)'.");
    out.push("    It means a shipped matcher does not behave in Loki as classifyBrokerLine does.");
  }
  return out.join("\n");
}

async function lokiCount(query, window) {
  const url = new URL("/loki/api/v1/query", LOKI_BASE_URL);
  url.searchParams.set("query", buildCountQuery(query, window));
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`loki ${res.status} for ${query}`);
  const body = await res.json();
  const result = body?.data?.result ?? [];
  return result.length ? Number(result[0].value[1]) : 0;
}

async function lokiNewest(window) {
  const url = new URL("/loki/api/v1/query_range", LOKI_BASE_URL);
  const end = Date.now() * 1e6;
  url.searchParams.set("query", BROKER_STREAM);
  url.searchParams.set("start", String(end - windowNanos(window)));
  url.searchParams.set("end", String(end));
  url.searchParams.set("limit", "1");
  url.searchParams.set("direction", "backward");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`loki ${res.status} on newest-entry probe`);
  const body = await res.json();
  const streams = body?.data?.result ?? [];
  if (!streams.length) return null;
  return new Date(Number(streams[0].values[0][0]) / 1e6).toISOString();
}

export function windowNanos(window) {
  assertWindow(window);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[window.slice(-1)];
  return Number(window.slice(0, -1)) * unit * 1e9;
}

async function main() {
  const { window, json } = parseArgs(process.argv.slice(2));
  const rows = [];
  for (const q of BROKER_QUERIES) {
    rows.push({ ...q, count: q.observable ? await lokiCount(q.logql, window) : null });
  }
  const streamTotal = await lokiCount(BROKER_STREAM, window);
  const newest = await lokiNewest(window);
  if (json) {
    console.log(JSON.stringify({ window, stream: BROKER_STREAM, streamTotal, newest, rows }, null, 2));
  } else {
    console.log(formatReport(rows, { window, streamTotal, newest }));
  }
}

if (process.argv[1] && process.argv[1].endsWith("github-publish-broker-soak-queries.mjs")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
