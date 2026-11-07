import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAdapterUtilsAlias } from "./src/server/adapter-utils-alias.js";

// `@paperclipai/adapter-utils` is imported by src/ (job-manifest.ts,
// runtime-pin.ts) and by several suites, but this package neither declares it
// as a dependency nor has a node_modules link to it — so those imports fail
// ERR_MODULE_NOT_FOUND when the suite is run from this directory. Reproduced
// at origin/master on src/server/job-manifest.test.ts, which has been
// unrunnable from here (0 tests collected) independently of PEN-4518. Point
// them at the monorepo source, which is what they mean and what the
// type-checker already resolves them to. Mirrors the sibling claude-k8s
// adapter's config, where this was fixed first.
const adapterUtilsSrc = (sub: string) =>
  fileURLToPath(
    new URL(`../../packages/adapter-utils/src/${sub}`, import.meta.url),
  );

// Monorepo-only: see src/server/adapter-utils-alias.ts for why this must not
// apply when the adapter directory is built on its own, and for the test that
// holds the absent branch down.
const adapterUtilsAlias = buildAdapterUtilsAlias({
  resolveSrc: adapterUtilsSrc,
  exists: existsSync,
});

export default defineConfig({
  resolve: {
    alias: adapterUtilsAlias,
  },
  test: {
    // PEN-5982, mirroring the sibling claude-k8s adapter (BLO-48145). This
    // suite runs its slowest tests at 60-66% of vitest's 5s default, so the
    // margin between routine and fatal is ~1.7s. Measured on CI job
    // 128429016429 (merge_group batch bb8e52ca): 3317 / 3301 / 3266 ms in
    // execute.test.ts and 3183 / 2561 / 2273 ms in shared-doc-overlay.test.ts,
    // all passing, alongside one 6822 ms timeout. The execute.test.ts trio
    // reproduces at 3260-3262 ms on an idle machine, so that 65% is structural
    // -- a fixed poll-interval wait, not runner noise -- and contention is
    // added on top of it rather than being the whole of it.
    //
    // A timeout here is not a re-run: inside a `merge_group` run it EVICTS the
    // PR from the merge queue, which costs a human enqueue rather than an
    // automatic retry (#3468, removed 2026-11-07T14:52:29Z, still unmerged).
    //
    // Deliberately suite-wide rather than a per-test override on the one test
    // that lost: six tests across two files share the exposure, so patching the
    // loser is how this returns wearing a different test's name. 30s puts the
    // slowest known test at ~11%. It weakens no assertion -- a hang still
    // fails, just later, and the job's `timeout-minutes: 17` remains the real
    // hang detector (BLO-35615).
    //
    // `hookTimeout` is deliberately NOT set: measured by tightening it against
    // shared-doc-overlay.test.ts, whose `beforeEach` does five real git
    // spawns, the hook completes in 1.0-1.5s -- 10-15% of vitest's 10s
    // default, against the test half's 65%. The hook half is not an exposure
    // today. Note that if it ever becomes one it must be fixed HERE: a root
    // CLI `--hookTimeout` is inert under Vitest 4 `projects` (BLO-37184).
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
