import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderTemplate(template, extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      "--show-only",
      template,
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("worker StatefulSet uses HTTP probes so readiness requires a listening server", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  assert.match(rendered, /livenessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /readinessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /startupProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /path: \/healthz/);
  assert.doesNotMatch(rendered, /grep -qa 'server\/dist\/index\.js'/);
});

test("API deployment keeps HTTP health probes", () => {
  const rendered = renderTemplate("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
  ]);

  assert.match(rendered, /livenessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /readinessProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /startupProbe:[\s\S]*?httpGet:/);
  assert.match(rendered, /path: \/healthz/);
  assert.doesNotMatch(rendered, /grep -qa 'server\/dist\/index\.js'/);
});

// Smallest readiness failureThreshold that still requires *consecutive*
// failures before the only Service endpoint is removed. See BLO-31945.
const MIN_READINESS_FAILURE_THRESHOLD = 3;

function probeSettings(rendered, probeName) {
  const match = rendered.match(
    new RegExp(`^(\\s*)${probeName}:\\n((?:\\1\\s+.*\\n)+)`, "m"),
  );
  assert.ok(match, `${probeName} not found in rendered template`);
  const block = match[2];
  const read = (key) => {
    const found = block.match(new RegExp(`\\b${key}:\\s*(\\d+)`));
    assert.ok(found, `${probeName} is missing ${key}`);
    return Number(found[1]);
  };
  return {
    periodSeconds: read("periodSeconds"),
    timeoutSeconds: read("timeoutSeconds"),
    failureThreshold: read("failureThreshold"),
  };
}

// BLO-31945. A readiness probe exists to shed traffic to healthy peers. The
// worker StatefulSet runs a single replica, so there is no peer: dropping the
// only Service endpoint does not redirect plugin traffic, it 502s it with
// "Worker tier unreachable" from worker-tier-proxy.ts, taking Alertmanager
// webhook delivery down with it. Measured on paperclip-0 over 24h to
// 2026-09-05T20:30Z, the 5s readiness timeout failed at 2.53x the rate of the
// 10s liveness timeout against the identical /healthz (1.171% vs 0.462%),
// while p99.9 of successful liveness probes was 8.59s — i.e. the readiness
// timeout had been set below the endpoint's own tail latency.
//
// Three separate knobs can each reopen that outage, so all three are asserted:
// the timeout (how easily one probe reports failure), failureThreshold (how
// many failures are needed to act on it), and the timeout/period relationship.
// Guarding only the timeout leaves failureThreshold as the next lever a reader
// reaches for once told the timeout is off limits.
test("worker readiness probe cannot be re-tightened into the BLO-31945 outage", () => {
  const rendered = renderTemplate("templates/statefulset.yaml");

  const replicas = Number(rendered.match(/^\s*replicas:\s*(\d+)/m)?.[1]);
  assert.ok(Number.isInteger(replicas), "could not read worker replicas");

  const readiness = probeSettings(rendered, "readinessProbe");
  const liveness = probeSettings(rendered, "livenessProbe");

  // Deliberately scoped to replicas === 1. Once the worker runs two or more
  // replicas (BLO-29307 / BLO-29004), readiness can genuinely shed load to a
  // peer and tightening it again becomes a legitimate choice — this guard
  // should not block that.
  if (replicas === 1) {
    assert.ok(
      readiness.timeoutSeconds >= liveness.timeoutSeconds,
      `readiness timeoutSeconds (${readiness.timeoutSeconds}s) must not be shorter than ` +
        `liveness (${liveness.timeoutSeconds}s) on a single-replica worker: with no peer to ` +
        `shed to, a readiness failure removes the only endpoint and 502s all plugin traffic. ` +
        `See BLO-31945.`,
    );

    // The floor is 3, not `>= liveness.failureThreshold`. Liveness is 6 and
    // readiness is 3, so keying off liveness would fail against the very
    // configuration this guard is meant to protect. 3 is the smallest value
    // that still requires *consecutive* failures, which is the property that
    // matters: at the 0.462% per-probe failure rate this endpoint exhibits,
    // needing three in a row makes an endpoint drop rare, while
    // failureThreshold: 1 drops the only endpoint on any single tail-latency
    // blip and reopens the outage — with every other assertion here still
    // green.
    assert.ok(
      readiness.failureThreshold >= MIN_READINESS_FAILURE_THRESHOLD,
      `readiness failureThreshold (${readiness.failureThreshold}) must be at least ` +
        `${MIN_READINESS_FAILURE_THRESHOLD} on a single-replica worker: a lower threshold lets ` +
        `an isolated slow /healthz remove the only Service endpoint, which 502s all plugin ` +
        `traffic rather than shedding it. See BLO-31945.`,
    );
  }

  assert.ok(
    readiness.timeoutSeconds <= readiness.periodSeconds,
    `readiness timeoutSeconds (${readiness.timeoutSeconds}s) must not exceed periodSeconds ` +
      `(${readiness.periodSeconds}s), or one probe can outlast its own period. See BLO-31945.`,
  );
});
