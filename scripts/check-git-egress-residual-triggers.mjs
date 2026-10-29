#!/usr/bin/env node
// PEN-4988: the standing detector for §7.2 trigger 2 of
// `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`.
//
// Usage: node scripts/check-git-egress-residual-triggers.mjs
//   env: LOKI_URL     (default http://loki.monitoring.svc.cluster.local:3100)
//        WINDOW_MINUTES (default 90)
// Exit 0 = clear, 1 = trigger 2 FIRED, 2 = could not run (NOT "clear").
//
// WHAT IT WATCHES
// ---------------
// §7.2 trigger 2 is "any agent Job rendering `paperclip.io/data-mount-scope:
// broad:*`", which re-opens bypass 3 and returns the guard to peers-not-layers.
// §2.1 of the decision doc calls that annotation "the regression detector for
// this bypass" and says it "is a cheap alerting target and should be one". This
// is that alerting target. Until PEN-4988 nothing watched ANY §7.2 trigger, and
// the residual acceptance runs to 2027-01-31 unless one fires — so a trigger
// that fired unnoticed was indistinguishable from one that never fired.
//
// WHY THE SERVER LOG AND NOT THE JOB ANNOTATION
// ---------------------------------------------
// The annotation and the server warn are written from the SAME variable
// (`broadDataMountReason`) a few lines apart in `buildJobManifest`
// (vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts). They are two
// renderings of one computation, not independent evidence — so the choice
// between them is purely about which is observable, and the log wins twice:
//
//   * COMPLETENESS. Agent Jobs carry `ttlSecondsAfterFinished: 300`, so a Job
//     is reaped five minutes after it finishes. A poll of live Jobs therefore
//     SAMPLES: a broad Job that starts and finishes between two polls is never
//     seen, and the gap is invisible in the output. The warn is emitted once per
//     render and persists for Loki's retention, so a window query covers every
//     render in that window rather than those alive at one instant.
//   * REACHABILITY. The annotation lives on the Job, not on the Pod (the pod
//     template carries labels only — read off a live Job 2026-10-29). Reading it
//     needs `batch/jobs: list`, and the least-privilege credential this repo's CI
//     holds — `paperclip-ci-deploy`, the identity behind
//     KUBECONFIG_PAPERCLIP_CI_DEPLOY — has `pods: get,list` and NO batch grant at
//     all (Role read 2026-10-29). An annotation arm would need a new RBAC grant
//     in Blockcast/onprem-k8s, which cannot land from here.
//
// ⚠ THE RISK THIS TRADES INTO, AND WHY IT IS COVERED. A log-based detector goes
// permanently silent if the producer stops emitting — and silence is byte-identical
// to "clear". That is NOT left to trust: the warn is pinned by unit tests on all
// three fallback legs (`isolation_disabled`, `no_claim`, `foreign_claim`) in
// vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.test.ts, under
// "names the reason whenever the broad rw mount is emitted". A change that drops
// the warn reds CI before it can blind this check. Do not delete those tests as
// redundant with the annotation assertions beside them; they are this detector's
// liveness proof.
//
// ⛔ WHAT A ZERO FROM THIS SCRIPT DOES NOT MEAN
// ---------------------------------------------
//   * It is not a statement about triggers 1, 3 or 4. Only trigger 2 is watched
//     here; §7.2 records what watches each of the others, including the two that
//     nothing watches.
//   * It cannot see further back than the window, and Loki retention bounds that
//     absolutely. Consecutive runs must OVERLAP or renders fall between them —
//     which is why the default window (90 min) exceeds the hourly cadence.
//   * It observes RENDERS, not the mount a running pod actually got. Those agree
//     by construction today because one variable decides both.

const DEFAULT_LOKI_URL = "http://loki.monitoring.svc.cluster.local:3100";
const DEFAULT_WINDOW_MINUTES = 90;

/**
 * The stream the paperclip-api server writes to. `container="paperclip"` is
 * load-bearing: ns `paperclip` also carries every agent pod's own `claude`
 * container, and an unscoped query would let agent output match this needle and
 * report a render that never happened.
 */
export const LOKI_QUERY =
  '{namespace="paperclip",container="paperclip"} |= "claude_k8s.data_mount_broad_rw"';

/** Exit codes, named so callers and tests cannot drift from the workflow. */
export const CLEAR = 0;
export const FIRED = 1;
export const UNREADABLE = 2;

/**
 * Pulls the `reason` leg and the Job out of each matched warn so the alert can
 * say WHICH leg of the gate fell through — all three are operator-fixable config
 * and they have different remedies.
 *
 * Tolerant by design: the line is JSON but reaches us wrapped in whatever the
 * server's logger prefixes, and a parse failure must never downgrade a FIRED
 * verdict to a clear one. An unparseable line still counts as an occurrence.
 */
export function summariseEntries(streams) {
  const occurrences = [];
  for (const stream of streams ?? []) {
    for (const [ts, line] of stream?.values ?? []) {
      // ANSI first: the target warn is a bare `console.warn(JSON.stringify(...))`
      // and parses as-is, but the server's other lines arrive colourised, and a
      // colour reset trailing the JSON is enough to fail the parse. Stripping
      // keeps the diagnostic useful if the warn is ever routed through the logger.
      const plain = typeof line === "string" ? line.replace(/\u001b\[[0-9;]*m/g, "") : "";
      let parsed = null;
      const start = plain.indexOf("{");
      if (start >= 0) {
        try {
          parsed = JSON.parse(plain.slice(start));
        } catch {
          parsed = null;
        }
      }
      occurrences.push({
        ts,
        reason: parsed?.reason ?? "(unparsed)",
        jobName: parsed?.jobName ?? "(unparsed)",
        runId: parsed?.runId ?? "(unparsed)",
      });
    }
  }
  return occurrences;
}

/** Renders the report the workflow tees to the step summary and the alert reads. */
export function renderReport({ occurrences, windowMinutes, lokiUrl }) {
  const lines = [
    "PEN-3183 §7.2 trigger 2 — agent Job rendered a broad data mount",
    `window_minutes = ${windowMinutes}`,
    `loki           = ${lokiUrl}`,
    `query          = ${LOKI_QUERY}`,
    `occurrences    = ${occurrences.length}`,
  ];
  if (occurrences.length === 0) {
    lines.push("verdict        = clear");
    return lines.join("\n");
  }
  lines.push("verdict        = fired");
  // Distinct reasons first: that is the remedy selector, and a flood of renders
  // from one cause should not bury a second cause further down the list.
  const reasons = [...new Set(occurrences.map((o) => o.reason))].sort();
  lines.push(`reasons        = ${reasons.join(", ")}`);
  for (const o of occurrences.slice(0, 20)) {
    lines.push(`  ${o.ts}  reason=${o.reason}  job=${o.jobName}  run=${o.runId}`);
  }
  if (occurrences.length > 20) lines.push(`  ... and ${occurrences.length - 20} more`);
  return lines.join("\n");
}

async function main() {
  const lokiUrl = (process.env.LOKI_URL || DEFAULT_LOKI_URL).replace(/\/+$/, "");
  const windowMinutes = Number(process.env.WINDOW_MINUTES || DEFAULT_WINDOW_MINUTES);
  // An unparseable window would silently become a NaN range that Loki answers
  // with an empty result — i.e. a confident false clear. Refuse instead.
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    console.error(`::error::WINDOW_MINUTES must be a positive number, got ${process.env.WINDOW_MINUTES}`);
    process.exit(UNREADABLE);
  }

  const endNs = `${Date.now()}000000`;
  const startNs = `${Date.now() - windowMinutes * 60_000}000000`;
  const url = new URL(`${lokiUrl}/loki/api/v1/query_range`);
  url.searchParams.set("query", LOKI_QUERY);
  url.searchParams.set("start", startNs);
  url.searchParams.set("end", endNs);
  url.searchParams.set("limit", "1000");

  let body;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) {
      console.error(`::error::Loki returned ${response.status} for ${lokiUrl}`);
      process.exit(UNREADABLE);
    }
    body = await response.json();
  } catch (error) {
    console.error(`::error::could not reach Loki at ${lokiUrl}: ${error.message}`);
    process.exit(UNREADABLE);
  }

  if (body?.status !== "success") {
    console.error(`::error::Loki answered status=${body?.status ?? "(absent)"}; not a usable verdict`);
    process.exit(UNREADABLE);
  }

  const occurrences = summariseEntries(body?.data?.result);
  console.log(renderReport({ occurrences, windowMinutes, lokiUrl }));
  process.exit(occurrences.length === 0 ? CLEAR : FIRED);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
