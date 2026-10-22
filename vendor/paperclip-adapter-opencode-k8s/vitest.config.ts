import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

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

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@paperclipai\/adapter-utils$/,
        replacement: adapterUtilsSrc("index.ts"),
      },
      {
        find: /^@paperclipai\/adapter-utils\/(.*)$/,
        replacement: adapterUtilsSrc("$1.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
});
