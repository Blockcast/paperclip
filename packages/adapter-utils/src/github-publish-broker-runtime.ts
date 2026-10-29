// PEN-4933 / PEN-3183 D1: entrypoint for the broker sidecar.
//
// Started by the agent Job's `github-publish-broker` container as
//
//   paperclip-github-token-env node .../github-publish-broker-runtime.js
//
// so the credential is in THIS process's environment, and in no process the
// agent container can see. It then listens on the shared `emptyDir` socket for
// as long as the Job lives.
//
// The container, not this file, is the boundary. Everything this module does
// about trust is in `github-publish-broker-policy.ts`; everything here is
// lifecycle.

import { createPublishBrokerServer } from "./github-publish-broker.js";
import { BROKER_SOCKET_ENV } from "./github-publish-broker-client.js";

/** Where the Job manifest mounts the shared socket directory. */
export const DEFAULT_BROKER_SOCKET_PATH = "/var/run/paperclip-github-broker/broker.sock";

/** Root the request `cwd` must resolve under. Set by the Job manifest. */
export const BROKER_WORKSPACE_ROOT_ENV = "PAPERCLIP_GITHUB_BROKER_WORKSPACE_ROOT";

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const socketPath = env[BROKER_SOCKET_ENV] || DEFAULT_BROKER_SOCKET_PATH;
  const workspaceRoot = env[BROKER_WORKSPACE_ROOT_ENV];
  // Refuse to start rather than defaulting the root. A broker with no
  // workspace confinement would accept a `cwd` anywhere its own mounts reach,
  // including the directory the token is mounted in — and it would do so
  // silently, which is the one failure mode a boundary must not have.
  if (!workspaceRoot) {
    throw new Error(
      `paperclip-github-broker: ${BROKER_WORKSPACE_ROOT_ENV} is unset; refusing to start without a workspace ` +
        "root to confine requests to",
    );
  }

  const server = await createPublishBrokerServer({ socketPath, workspaceRoot, env });
  process.stderr.write(
    `paperclip-github-broker: listening on ${server.socketPath}, publishing from under ${workspaceRoot}\n`,
  );

  // A sidecar is terminated when the main container exits. Close the listener
  // so the socket file does not outlive the pod on a shared mount, then let
  // node's event loop drain.
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && process.argv[1].endsWith("github-publish-broker-runtime.js")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
