import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";
import { afterAll, vi } from "vitest";

type SupertestServer = NetServer & {
  address(): ReturnType<NetServer["address"]>;
  listen(port: number): NetServer;
};

type SupertestTestInstance = {
  _server?: SupertestServer;
};

type SupertestTestConstructor = {
  prototype: {
    serverAddress(this: SupertestTestInstance, app: SupertestServer, path: string): string;
    __paperclipLoopbackPatched?: boolean;
  };
};

const require = createRequire(import.meta.url);
const SupertestTest = require("supertest/lib/test.js") as SupertestTestConstructor;

if (!process.env.CODEX_HOME) {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-vitest-codex-home-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-vitest"}\n', { mode: 0o600 });
  process.env.CODEX_HOME = codexHome;
  // Setup files run once per test file; without this every server test file
  // leaves one of these dirs behind in $TMPDIR (BLO-44941).
  afterAll(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (process.env.CODEX_HOME === codexHome) delete process.env.CODEX_HOME;
  });
}

// Per-run artifact stores must never be written to the real instance root
// during tests. Each of these falls back to
// `<PAPERCLIP_HOME>/instances/<id>/data/<...>`, so without an override every
// suite that starts a run writes into the live store the deployed server owns.
//
// In an agent sandbox that is fatal rather than merely untidy: `instances/default`
// is the BLO-32734 `instance-overlay` emptyDir, and the kubelet creates the parent
// chain of each `subPath` bind on it as root:root 0755, which is EACCES for the
// uid 1000 the tests run as. The resulting `EACCES: … mkdir '…/data/run-logs/…'`
// is raised during run startup and reaches the test only as a downstream assertion
// (`firstAdapterStarted` false, run `failed`), which reads like a scheduling
// regression — PEN-5424 measured 4 of 23 failures in
// `heartbeat-dependency-scheduling.test.ts` from this alone, and confirming it was
// environmental cost a matched two-arm run of ~28 minutes per arm.
//
// Widening the overlay would re-open what BLO-32734 phase 2a closed, and the run's
// OWN log directory is already bound writable; it is the shared root that a test
// has no business touching. CI is unaffected by the EACCES (nothing under
// `.github/` sets PAPERCLIP_HOME, so the root lands in the runner's own `$HOME`),
// but it is affected by the pollution, which this removes there too.
const INSTANCE_ROOT_ARTIFACT_STORE_ENV_VARS = [
  "RUN_LOG_BASE_PATH",
  "WORKSPACE_OPERATION_LOG_BASE_PATH",
] as const;

for (const envVar of INSTANCE_ROOT_ARTIFACT_STORE_ENV_VARS) {
  if (process.env[envVar]) continue;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paperclip-vitest-${envVar.toLowerCase()}-`));
  process.env[envVar] = dir;
  // Same per-file lifecycle as CODEX_HOME above: setup files run once per test
  // file, so without this each one leaks a directory into $TMPDIR.
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (process.env[envVar] === dir) delete process.env[envVar];
  });
}

// `vi.waitFor`'s timeout is NOT reachable from vitest.config.ts: it is a
// hard-coded `timeout = 1e3` default inside the runner's own `waitFor`
// (vitest 4.1.8), so the BLO-17026 lift of testTimeout/hookTimeout/
// teardownTimeout onto the shared ARC pool could not reach it. That leaves a
// 1s budget as the tightest clock in the suite — 60x tighter than the
// testTimeout chosen for this very environment — on call sites that are
// SYNCHRONISATION waits, not latency assertions: they wait for an async
// chain to reach a point, and the assertion that follows is about ordering
// or arguments, never about how long the wait took.
//
// Measured on `server-startup-feedback-export.test.ts`, whose
// `vi.waitFor(() => expect(fakeServer.close).toHaveBeenCalled())` after a
// SIGTERM takes 51/53/51 ms on an idle host — essentially one 50ms poll
// interval — and which failed twice at >1000ms on a merge-group shard that
// took 1217s with 451s of imports (PEN-3381). A false red there ejected the
// queue head and cost a full re-queue.
//
// 5_000 matches the headroom already hand-applied at the three call sites
// that carry an explicit `timeout: 5_000` (a fourth carries 2_000). Raising
// the DEFAULT cannot weaken an assertion: no site asserts that a
// default-budget `vi.waitFor` rejects, and each test's own `testTimeout`
// (60_000) still bounds the wait. An explicit per-call timeout still wins, so
// a site that genuinely means to assert a short bound keeps it — which is the
// case `waitfor-default-budget.test.ts` pins.
const PAPERCLIP_WAIT_FOR_DEFAULT_TIMEOUT_MS = 5_000;

type WaitForOptions = Parameters<typeof vi.waitFor>[1];

const viWithPatchFlag = vi as typeof vi & { __paperclipWaitForDefaultPatched?: boolean };

if (!viWithPatchFlag.__paperclipWaitForDefaultPatched) {
  const originalWaitFor = vi.waitFor.bind(vi) as typeof vi.waitFor;

  vi.waitFor = (<T,>(callback: () => T | Promise<T>, options?: WaitForOptions) => {
    if (typeof options === "number") return originalWaitFor(callback, options);
    if (options && typeof options.timeout === "number") return originalWaitFor(callback, options);
    return originalWaitFor(callback, { ...options, timeout: PAPERCLIP_WAIT_FOR_DEFAULT_TIMEOUT_MS });
  }) as typeof vi.waitFor;

  viWithPatchFlag.__paperclipWaitForDefaultPatched = true;
}

if (!SupertestTest.prototype.__paperclipLoopbackPatched) {
  SupertestTest.prototype.serverAddress = function serverAddress(app, path) {
    const addr = app.address();

    if (!addr) {
      this._server = app.listen(0) as SupertestServer;
    }

    const listeningAddress = app.address() as AddressInfo | string | null;
    if (!listeningAddress || typeof listeningAddress === "string") {
      throw new Error("Expected Supertest server to listen on a TCP port");
    }

    const host = listeningAddress.address === "::"
      ? "[::1]"
      : listeningAddress.address === "0.0.0.0"
        ? "127.0.0.1"
        : listeningAddress.address;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${host}:${listeningAddress.port}${path}`;
  };

  SupertestTest.prototype.__paperclipLoopbackPatched = true;
}
