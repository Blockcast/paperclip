// Suite enumeration shared between scripts/run-vitest-stable.mjs (the actual
// test runner) and scripts/check-shard-manifest-freshness.mjs (the manifest
// drift diagnostic, BLO-24241). Previously each file walked the tree and
// applied the route/authz exclusion independently; a diagnostic computed
// from a second, drifted copy of this logic would tell you nothing about
// the manifest that actually feeds the real runner.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;

// Server suites that are not route/authz-named but are pinned to the
// serialized lane anyway. Read the note on isRouteOrAuthzTest below before
// concluding anything from this list: the general-server shards are not
// "parallel" -- every server suite runs single-worker and file-isolated in
// either lane -- so membership here buys `--retry=1` and a separate Vitest
// invocation, not stronger isolation.
export const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
]);

export function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

export function toRepoPath(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

// WHAT THIS PREDICATE IS, AND WHAT IT IS NOT (BLO-28956).
//
// It selects which of the two Vitest INVOCATIONS a server suite runs in --
// the `general-server` one or the `serialized` one. Both invocations run in
// the same CI job, back to back, and both inherit server/vitest.config.ts,
// which pins `pool: "forks"`, `isolate: true`, `maxWorkers: 1` and
// `sequence.concurrent: false`. Serialization and per-file isolation are
// therefore properties of the SERVER PROJECT CONFIG, not of this lane split:
// a suite is exactly as serialized on either side of this line. The only
// behavioural difference left is `--retry=1` on the serialized invocation
// (BLO-17053), plus the separate PAPERCLIP_HOME/TMPDIR each invocation gets.
//
// The lane split dates from #4423, when the serialized lane ran one Vitest
// PROCESS PER FILE and the split really did buy stronger isolation. #8360
// then gave the rest of the server the same shard treatment, and BLO-17053
// batched the serialized lane into one invocation, which is what erased the
// difference. The split survives because the two lanes are two invocations,
// not because any suite needs it to be.
//
// Consequence, and the reason this comment exists: nothing about this
// predicate makes the suites on the serialized side UNWEIGHTABLE. It says
// which lane a suite runs in; it says nothing about how suites should be
// PACKED within that lane. Both lanes are partitioned by recorded duration
// from the same manifest (scripts/general-server-shard-durations.json).
export function isRouteOrAuthzTest(repoPath) {
  if (routeTestPattern.test(repoPath)) {
    return true;
  }
  return additionalSerializedServerTests.has(repoPath);
}

function collectServerTestFiles(repoRoot) {
  const serverSrcDir = path.join(repoRoot, "server", "src");
  return walk(serverSrcDir)
    .map((file) => toRepoPath(repoRoot, file))
    .filter((repoPath) => repoPath.endsWith(".test.ts"));
}

// Every server test file the general-server group is responsible for, i.e.
// the whole server project minus the route/authz suites that run in the
// dedicated serialized shards.
export function collectGeneralServerSuiteFiles(repoRoot) {
  return collectServerTestFiles(repoRoot)
    .filter((repoPath) => !isRouteOrAuthzTest(repoPath))
    .sort((a, b) => a.localeCompare(b));
}

// The other half: the route/authz suites the serialized lane runs.
export function collectSerializedServerSuiteFiles(repoRoot) {
  return collectServerTestFiles(repoRoot)
    .filter((repoPath) => isRouteOrAuthzTest(repoPath))
    .sort((a, b) => a.localeCompare(b));
}

// Both lanes together. This is the set scripts/general-server-shard-
// durations.json is expected to have an entry for: it weights BOTH shard
// partitions, so measuring, freshness-checking or pruning it against only
// the general half would leave the serialized half permanently unweighted --
// which is the defect BLO-28956 fixed.
export function collectAllServerSuiteFiles(repoRoot) {
  return collectServerTestFiles(repoRoot).sort((a, b) => a.localeCompare(b));
}
