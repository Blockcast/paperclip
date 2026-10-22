import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildAdapterUtilsAlias } from "./src/server/adapter-utils-alias.js";

// `@paperclipai/adapter-utils` is imported by src/ (session.ts, skills.ts) and by
// several suites, but this package neither declares it nor has a node_modules
// link to it — so those imports fail ERR_MODULE_NOT_FOUND when the suite is run
// from this directory (reproduced on src/server/execute-environment.test.ts).
// Point them at the monorepo source, which is what they mean and what the
// type-checker already resolves them to.
const adapterUtilsSrc = (sub: string) =>
  fileURLToPath(new URL(`../../packages/adapter-utils/src/${sub}`, import.meta.url));

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
    globals: true,
    // BLO-48145: many suites (env-guard, prompt-cache, runtime-pin) spawn real
    // node processes, so their wall time follows runner load rather than the
    // code under test. On oversubscribed CI runners single spawns have taken
    // >5 s, tripping vitest's 5 s default and ejecting unrelated PRs from the
    // merge queue. 30 s still fails a hang in async code; a hung `spawnSync`
    // child blocks the event loop, so no vitest timeout can interrupt it.
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
    },
  },
});
