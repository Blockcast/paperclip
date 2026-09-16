import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PAPERCLIP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-home-"));
const PAPERCLIP_INSTANCE_ID = "playwright-e2e";
const PAPERCLIP_CONFIG = path.join(PAPERCLIP_HOME, "instances", PAPERCLIP_INSTANCE_ID, "config.json");
const PAPERCLIP_AGENT_JWT_SECRET = process.env.PAPERCLIP_AGENT_JWT_SECRET ?? "playwright-e2e-agent-jwt-secret";
const PAPERCLIP_TOOL_ACTION_SIGNING_SECRET =
  process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET ?? "playwright-e2e-tool-action-signing-secret";
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

// `paperclipai run` auto-enables Vite dev middleware whenever the server runs
// from source (cli/src/commands/run.ts:143), which is how the e2e webServer
// below starts. Dev middleware serves the UI as an unbundled ES module graph,
// and every test gets a fresh browser context with an empty HTTP cache, so each
// navigation refetches the whole graph: measured 12-41s from document to the
// app's first request across all 26 navigations of one CI run (BLO-33478),
// flat over the run and unchanged on repeat hits to the same route. Nothing
// renders in that window — CloudAccessGate holds `Loading...` until /api/health
// resolves — so any assertion on post-boot DOM races it. Serve the built bundle
// when one exists; a checkout without `pnpm --filter @paperclipai/ui build`
// keeps the dev-middleware behaviour.
const UI_DIST_INDEX = path.resolve(import.meta.dirname, "../../ui/dist/index.html");
const UI_DIST_EXISTS = fs.existsSync(UI_DIST_INDEX);

// The fallback above is silent in both directions, so in CI it would mask its
// own removal: drop or reorder the build step and the suite reverts to dev
// middleware, goes green but slow, and nothing in the log says why. Both CI
// consumers of this config do build the UI first -- pr.yml via
// `pnpm --filter @paperclipai/ui build`, e2e.yml via `pnpm -r build` -- so a
// missing bundle under CI is a broken workflow, not a valid configuration.
if (!UI_DIST_EXISTS && process.env.CI) {
  throw new Error(
    `e2e: missing ${UI_DIST_INDEX}\n` +
      "CI must build the UI bundle before running e2e: pnpm --filter @paperclipai/ui build\n" +
      "Without it the suite silently falls back to Vite dev middleware (BLO-33478).",
  );
}

const UI_DEV_MIDDLEWARE = UI_DIST_EXISTS ? "false" : "true";

process.env.PAPERCLIP_HOME = PAPERCLIP_HOME;
process.env.PAPERCLIP_CONFIG = PAPERCLIP_CONFIG;
process.env.PAPERCLIP_AGENT_JWT_SECRET = PAPERCLIP_AGENT_JWT_SECRET;
process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = PAPERCLIP_TOOL_ACTION_SIGNING_SECRET;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // These suites target dedicated multi-user configurations/ports and are
  // intentionally not part of the default local_trusted e2e run.
  testIgnore: ["multi-user.spec.ts", "multi-user-authenticated.spec.ts"],
  timeout: 60_000,
  // A single flake on a shared, serial-worker suite (BLO-20657) shouldn't red a PR
  // that didn't touch the failing spec. Local runs stay fail-fast at 0.
  retries: process.env.CI ? 1 : 0,
  // All specs share one throwaway server, and several toggle instance-level
  // state (the `enableConferenceRoomChat` experimental flag) that changes
  // which UI variant renders. Run files serially so a flag flip in one spec
  // can't change the wizard/thread under another spec mid-flight.
  //
  // This bounds INTRA-job parallelism only. It is NOT a ban on cross-job
  // `--shard=i/N`: each sharded job boots its own throwaway PAPERCLIP_HOME via
  // `mkdtempSync` + `reuseExistingServer: false`, so cross-shard flag flips
  // cannot interact. BLO-33282 measured sharding anyway and ruled against it
  // for now -- `smoke-lab.spec.ts` is a single 18.6m test worth 44% of the
  // suite, and Playwright balances shards by test count, so no N balances.
  // See the `e2e` job comment in .github/workflows/pr.yml before revisiting.
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  // The webServer directive bootstraps a throwaway instance and then starts it.
  // `onboard --yes --run` works in a non-interactive temp PAPERCLIP_HOME.
  webServer: {
    command: `pnpm paperclipai onboard --yes --run`,
    url: `${BASE_URL}/api/health`,
    // Always boot a dedicated throwaway instance for e2e so browser tests
    // never attach to the developer's active Paperclip home/server.
    reuseExistingServer: false,
    // ARC cold starts can spend more than two minutes bootstrapping embedded
    // PostgreSQL and the server before the health endpoint becomes available.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      PAPERCLIP_HOME,
      PAPERCLIP_INSTANCE_ID,
      PAPERCLIP_CONFIG,
      PAPERCLIP_AGENT_JWT_SECRET,
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET,
      PAPERCLIP_BIND: "loopback",
      PAPERCLIP_UI_DEV_MIDDLEWARE: UI_DEV_MIDDLEWARE,
      PAPERCLIP_DEPLOYMENT_MODE: "local_trusted",
      PAPERCLIP_DEPLOYMENT_EXPOSURE: "private",
    },
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
