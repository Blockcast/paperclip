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
// ## ⛔ Category (c) IS NOT OBSERVABLE, and this script refuses to print 0 for it
//
// Read before trusting any output. §5.3 states the broker "writes refusals and
// child stderr to its own container's stderr". Verified against `master` at
// 8be492039 on 2026-11-01, that is **wrong for child stderr entirely and
// partially wrong for refusals**. There are exactly three stderr sites in
// packages/adapter-utils/src/github-publish-broker.ts (the `log` definition at
// :278 and its two call sites, :366 and :417) plus two in
// github-publish-broker-runtime.ts (:39, :55). Everything else goes to the
// SOCKET, i.e. back to the agent, and never reaches the container's stderr:
//
//   - `sendExit(code)` (:439) frames the child's exit code to the socket. The
//     child's non-zero exit is therefore NEVER written to the broker's stderr.
//   - `child.stderr` (:426) is relayed to the socket, not logged.
//   - `child.on("error")` (:431), i.e. "unable to start the tool", likewise.
//   - The four protocol-level `refuse()` calls (:349 malformed frame, :355
//     second request on one connection, :373 stdin before request, :384 unknown
//     frame kind) are socket-only.
//
// So printing `child_nonzero_exit: 0` would be a lie of exactly the shape §5.3
// warns about -- indistinguishable from "no child ever failed". This script
// reports that category as NOT OBSERVABLE and carries the query that would work
// if the broker logged it, so the gap is recorded in code rather than in prose
// somebody has to remember. See the runbook for the one-line fix.
//
// ## What IS observable, and why these matchers are what they are
//
// Message shapes were read from source, not guessed. Two prefix families:
//
//   - Lines the broker writes about ITSELF are prefixed `paperclip-github-broker: `
//     -- the listen line (runtime.ts:39), the known startup throw (runtime.ts:33),
//     the per-invocation accept line (broker.ts:417), and the non-refusal parse
//     failure (broker.ts:364).
//   - `PublishBrokerRefusal` messages pass through UNPREFIXED (broker.ts:363
//     takes `error.message` verbatim). Every one of them in
//     github-publish-broker-policy.ts begins either "refusing " or "the broker
//     performs pushes, and this is ".
//
// That asymmetry is load-bearing and is why the refusal matcher is anchored.
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
 * Openings of every PublishBrokerRefusal message in
 * github-publish-broker-policy.ts. These reach stderr UNPREFIXED.
 */
export const REFUSAL_OPENINGS = ["refusing ", "the broker performs pushes, and this is "];

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
    logql: `${BROKER_STREAM} |= \`${SELF_PREFIX}listening on\``,
    note: "runtime.ts:39. The denominator for (a): a brokered pod with no listen line did not start.",
  },
  {
    id: "startup_failure_workspace_root",
    category: "a",
    label: "startup FAILURE (workspace root unset)",
    observable: true,
    logql: `${BROKER_STREAM} |= \`${SELF_PREFIX}PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset\``,
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
    // lines -- hence both exclusions.
    logql: `${BROKER_STREAM} != \`${SELF_PREFIX}\` !~ \`(?i)^(${REFUSAL_OPENINGS.map(escapeForLogqlRegex).join("|")})\``,
    note: "runtime.ts:55. Residual bucket: unprefixed and not a refusal ⇒ an unnamed startup error.",
  },
  {
    id: "policy_refusal",
    category: "b",
    label: "policy refusal (PublishBrokerRefusal)",
    observable: true,
    logql: `${BROKER_STREAM} |~ \`^(${REFUSAL_OPENINGS.map(escapeForLogqlRegex).join("|")})\``,
    note: "broker.ts:366 logging a policy.ts refusal. Anchored because the messages are unprefixed.",
  },
  {
    id: "protocol_refusal",
    category: "b",
    label: "protocol refusal (malformed frame / bad sequence)",
    observable: false,
    logql: `${BROKER_STREAM} |= \`${SELF_PREFIX}\` |~ \`(a second request on one connection|stdin arrived before a request|unknown frame kind)\``,
    note:
      "SOCKET-ONLY. broker.ts refuse() at :349/:355/:373/:384 writes to the socket, not stderr. " +
      "The query is kept for the day those are logged.",
  },
  {
    id: "invocation_accepted",
    category: "denominator",
    label: "invocations accepted (publish attempts)",
    observable: true,
    logql: `${BROKER_STREAM} |~ \`^${escapeForLogqlRegex(SELF_PREFIX)}(${BROKERED_TOOLS.map(escapeForLogqlRegex).join("|")}) in /\``,
    note: "broker.ts:417. Per-door publish attempts — the denominator stage 1's observations (b)/(c)/(d) need.",
  },
  {
    id: "child_nonzero_exit",
    category: "c",
    label: "child non-zero exits",
    observable: false,
    logql: `${BROKER_STREAM} |~ \`exited with code [1-9]\``,
    note:
      "⛔ NOT OBSERVABLE. sendExit() (broker.ts:439) frames the exit code to the socket and nothing " +
      "writes it to stderr. This query matches nothing TODAY and would match nothing even if every " +
      "publish failed. Do not read its 0 as evidence.",
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
 * Partition one broker stderr line. Pure, and the reason the query set can be
 * trusted: the queries above and this function must agree, which the tests
 * assert line-by-line against strings taken from the broker source.
 */
export function classifyBrokerLine(line) {
  const text = String(line ?? "");
  if (text.startsWith(SELF_PREFIX)) {
    const rest = text.slice(SELF_PREFIX.length);
    if (rest.startsWith("listening on")) return "startup_listening";
    if (rest.startsWith("PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT is unset")) return "startup_failure_workspace_root";
    for (const tool of BROKERED_TOOLS) {
      if (rest.startsWith(`${tool} in /`)) return "invocation_accepted";
    }
    return "self_reported_other";
  }
  for (const opening of REFUSAL_OPENINGS) {
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
  for (const r of rows) {
    const value = r.observable ? String(r.count) : "NOT OBSERVABLE";
    const tag = `[${r.category}]`.padEnd(14);
    out.push(`  ${tag} ${r.label.padEnd(48)} ${value.padStart(15)}`);
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
  const classified = rows.filter((r) => r.observable).reduce((n, r) => n + r.count, 0);
  if (streamTotal > 0 && classified !== streamTotal) {
    out.push("");
    out.push(`  ⚠ ${streamTotal - classified} line(s) matched no category — the partition is incomplete.`);
    out.push("    Re-read the broker's stderr sites; a new log line has been added.");
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
