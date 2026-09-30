import { defineConfig } from "vitest/config";

// Adding a project here is NOT enough to make CI run it. CI does not use this
// array: scripts/run-vitest-stable.mjs keeps its own `nonServerProjects` list
// (by package name, not directory), and both CI lanes run `--project <name>`
// off that list. A package listed here but missing there reports green because
// nothing ever ran it. Add new packages to BOTH files -- see BLO-20076, and
// scripts/__tests__/vitest-project-coverage.test.mjs, which fails when the two
// lists drift apart.

// BLO-28886 AC3: a per-test flake ledger needs the failing TEST name, and the
// only place that exists today is the job log -- 45-75s per download, and a
// batch of 18 timed out. Setting PAPERCLIP_VITEST_REPORT_DIR turns each vitest
// invocation into a machine-readable report that CI uploads as an artifact, so
// the ledger over ~50 runs becomes a query.
//
// Keyed on `process.pid` because run-vitest-stable.mjs spawns vitest MANY times
// per job (once per project for the workspaces groups, plus the serialized
// shard), each a fresh process -- a fixed filename would leave only the last
// invocation, and the one that matters is usually the one that exited first.
const flakeReportDir = process.env.PAPERCLIP_VITEST_REPORT_DIR;

export default defineConfig({
  test: {
    ...(flakeReportDir
      ? {
          reporters: ["default", "json"],
          outputFile: { json: `${flakeReportDir}/vitest-${process.pid}.json` },
        }
      : {}),
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
      "packages/plugins/paperclip-plugin-alertmanager",
      "packages/mcp-external",
      "packages/mcp-server",
      "packages/mcp-gateway",
      "server",
      "ui",
      "cli",
    ],
  },
});
