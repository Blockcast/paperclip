import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    environment: "node",
    // tests/wiki-route-sidebar-ui.spec.ts opts itself into jsdom with a
    // `// @vitest-environment jsdom` docblock and imports `act` from "react".
    // React only exports `act` from cjs/react.development.js -- the production
    // build has no such export -- and react/index.js picks the build off
    // process.env.NODE_ENV at require time. So with NODE_ENV=production in the
    // ambient shell, `act` resolves `undefined` and all 16 of that file's tests
    // fail with "TypeError: act is not a function", while the other two spec
    // files (85 tests) pass. The DOM is not the problem: document is defined in
    // that file either way.
    //
    // Vitest already defaults NODE_ENV to "test" when it is unset, so this only
    // pins that documented default against an inherited NODE_ENV. CI does not
    // rely on it -- scripts/run-vitest-stable.mjs sets NODE_ENV: "test" for
    // every vitest child -- but `pnpm test` in this directory does, and the
    // production-env case cost PEN-2506 a cycle and a wrong diagnosis on the
    // UNEXECUTED_WITH_TESTS ratchet ("needs a DOM environment and jsdom"; it
    // needs neither). Keep this until the spec stops importing `act`.
    env: { NODE_ENV: "test" },
  },
});
