import { defineConfig } from "vitest/config";

// Adding a project here is NOT enough to make CI run it. CI does not use this
// array: scripts/run-vitest-stable.mjs keeps its own `nonServerProjects` list
// (by package name, not directory), and both CI lanes run `--project <name>`
// off that list. A package listed here but missing there reports green because
// nothing ever ran it. Add new packages to BOTH files -- see BLO-20076, and
// scripts/__tests__/vitest-project-coverage.test.mjs, which fails when the two
// lists drift apart.
export default defineConfig({
  test: {
    projects: [
      "packages/shared",
      "packages/skills-catalog",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/grok-local",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/plugins/sdk",
      "packages/plugins/create-paperclip-plugin",
      "packages/mcp-external",
      "packages/mcp-server",
      "server",
      "ui",
      "cli",
    ],
  },
});
