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
    // that file either way -- though not for the reason the PEN-2506 ratchet
    // note used to give. jsdom has never resolved "through the workspace": the
    // repo root declares it nowhere. It reached these tests as a phantom
    // dependency -- pnpm hoisting `server`'s copy, long the sole importer
    // declaring jsdom, into node_modules/.pnpm/node_modules. PEN-4930 (#3072)
    // closes that by declaring jsdom on this package and adding a sweep for the
    // next package to request a non-node environment without declaring what
    // provides it. Whether that has landed is deliberately not asserted here:
    // this package's own package.json is the authority, and a comment that
    // restates it only rots. The corrected ratchet note is in
    // scripts/__tests__/vitest-project-coverage.test.mjs.
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
