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
    // suite's slowest tests sit at 60-66% of vitest's 5s default, so the margin
    // between routine and fatal is ~1.7s -- and a timeout here is not a re-run:
    // inside a `merge_group` run it EVICTS the PR from the merge queue, which
    // costs a human enqueue. Suite-wide on purpose: six tests across two files
    // share the exposure, so a per-test override on the one that lost is how
    // this returns wearing a different test's name. It weakens no assertion --
    // the job's `timeout-minutes: 17` remains the real hang detector
    // (BLO-35615), and src/vitest-config.test.ts holds this floor down.
    //
    // `hookTimeout` is deliberately NOT set; it measured at 10-15% of its own
    // default, so the hook half is not an exposure today. Measurements, and the
    // BLO-37184 caveat that a root CLI `--hookTimeout` would be inert here, are
    // in PROVENANCE-CHANGES.d/pen-5982.md.
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
