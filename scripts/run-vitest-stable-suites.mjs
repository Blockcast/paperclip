// Suite enumeration shared between scripts/run-vitest-stable.mjs (the actual
// test runner) and scripts/check-shard-manifest-freshness.mjs (the manifest
// drift diagnostic, BLO-24241). Previously each file walked the tree and
// applied the route/authz exclusion independently; a diagnostic computed
// from a second, drifted copy of this logic would tell you nothing about
// the manifest that actually feeds the real runner.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;

// Server suites that are not route/authz-named but must still run in the
// serialized lane (shared DB state, ordering sensitivity, etc.) rather than
// the parallel general-server shards.
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

export function isRouteOrAuthzTest(repoPath) {
  if (routeTestPattern.test(repoPath)) {
    return true;
  }
  return additionalSerializedServerTests.has(repoPath);
}

// Every server test file the general-server group is responsible for, i.e.
// the whole server project minus the route/authz suites that run in the
// dedicated serialized shards. This is the same set scripts/general-server-
// shard-durations.json is expected to have an entry for.
export function collectGeneralServerSuiteFiles(repoRoot) {
  const serverSrcDir = path.join(repoRoot, "server", "src");
  return walk(serverSrcDir)
    .map((file) => toRepoPath(repoRoot, file))
    .filter((repoPath) => repoPath.endsWith(".test.ts"))
    .filter((repoPath) => !isRouteOrAuthzTest(repoPath))
    .sort((a, b) => a.localeCompare(b));
}
