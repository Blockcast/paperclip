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
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
