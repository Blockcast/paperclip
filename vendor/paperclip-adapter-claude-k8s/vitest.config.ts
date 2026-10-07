import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// `@paperclipai/adapter-utils` is imported by src/ (session.ts, skills.ts) and by
// several suites, but this package neither declares it nor has a node_modules
// link to it — so those imports fail ERR_MODULE_NOT_FOUND when the suite is run
// from this directory (reproduced on src/server/execute-environment.test.ts).
// Point them at the monorepo source, which is what they mean and what the
// type-checker already resolves them to.
const adapterUtilsSrc = (sub: string) =>
  fileURLToPath(new URL(`../../packages/adapter-utils/src/${sub}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@paperclipai\/adapter-utils$/, replacement: adapterUtilsSrc("index.ts") },
      { find: /^@paperclipai\/adapter-utils\/(.*)$/, replacement: adapterUtilsSrc("$1.ts") },
    ],
  },
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/index.ts"],
    },
  },
});
