import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo, Server as NetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as TlsServer } from "node:tls";
import { afterAll } from "vitest";

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
