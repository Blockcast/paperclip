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
test("worker readiness probe is no tighter than liveness while the tier is single-replica", () => {
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
  }

  assert.ok(
    readiness.timeoutSeconds <= readiness.periodSeconds,
    `readiness timeoutSeconds (${readiness.timeoutSeconds}s) must not exceed periodSeconds ` +
      `(${readiness.periodSeconds}s), or one probe can outlast its own period. See BLO-31945.`,
  );
});
