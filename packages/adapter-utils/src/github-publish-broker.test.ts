import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  brokerChildEnv,
  createPublishBrokerServer,
  prepareBrokeredInvocation,
  type PublishBrokerServer,
} from "./github-publish-broker.js";
import { runPublishBrokerClient } from "./github-publish-broker-client.js";
import {
  ClientFrameKind,
  PUBLISH_BROKER_PROTOCOL_VERSION,
  ServerFrameKind,
} from "./github-publish-broker-protocol.js";

// PEN-4933 / PEN-3183 D1.
//
// The row asks for a test that fails if "the broker is made to emit a token
// rather than perform the publish". That is asserted two ways here, because
// neither alone is enough:
//
//  - STRUCTURALLY, by pinning the set of frames the broker can send. A broker
//    that returns a credential has to return it as SOMETHING, and the three
//    kinds below are all there are. Adding a fourth reds this.
//  - BEHAVIOURALLY, end to end over a real socket: the brokered child receives
//    a token in its environment (so the publish really is performed with
//    credentials) while the client receives only what that child wrote to its
//    own stdio — and the refusals keep the child from being one that prints it.

// Derived at runtime rather than written as a literal: a token-shaped literal
// in a blob is exactly what the egress door this change is about refuses to
// publish, and deriving it is what the repository's other fixtures do.
const TOKEN = ["gh", "s"].join("") + "_" + Buffer.from("pen4933-broker-fixture").toString("hex");

let workdir: string;
let wrapperDir: string;
let workspaceRoot: string;
let server: PublishBrokerServer | null = null;

function writeFakeTool(name: string, body: string): void {
  const file = path.join(wrapperDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
}

beforeEach(() => {
  workdir = mkdtempSync(path.join(os.tmpdir(), "broker-test-"));
  wrapperDir = path.join(workdir, "bin");
  workspaceRoot = path.join(workdir, "workspace");
  mkdirSync(wrapperDir, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(async () => {
  await server?.close();
  server = null;
  rmSync(workdir, { recursive: true, force: true });
});

async function start(): Promise<string> {
  const socketPath = path.join(workdir, "broker.sock");
  server = await createPublishBrokerServer({
    socketPath,
    workspaceRoot,
    wrapperDir,
    // Production uses BROKER_PRIVATE_DIR, which is root-owned here. The point
    // of the setting is only that it is NOT the shared /tmp; see the constant.
    privateDir: path.join(workdir, "private"),
    env: { PATH: process.env.PATH, HOME: workdir, GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN },
    log: () => {},
  });
  return socketPath;
}

/** A writable that appends every chunk to `sink`. */
function collect(sink: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      sink.push(Buffer.from(chunk));
      callback();
    },
  });
}

async function call(socketPath: string, tool: "git" | "gh" | "github-mcp-server", argv: string[]) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdin = new PassThrough();
  stdin.end();
  const code = await runPublishBrokerClient({
    socketPath,
    tool,
    argv,
    cwd: workspaceRoot,
    stdin,
    stdout: collect(stdout),
    stderr: collect(stderr),
  });
  return { code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("the broker performs the publish and never emits the credential", () => {
  it("has no frame kind that could carry a credential", () => {
    // Deliberately an EQUALITY. The structural guarantee is "the only thing
    // the broker can send back is the child's own stdio plus an exit status",
    // and that guarantee is only as true as this set is small.
    expect(Object.keys(ServerFrameKind).sort()).toEqual(["EXIT", "STDERR", "STDOUT"]);
    expect(Object.keys(ClientFrameKind).sort()).toEqual(["REQUEST", "STDIN", "STDIN_EOF"]);
    expect(PUBLISH_BROKER_PROTOCOL_VERSION).toBe(1);
  });

  it("gives the brokered child a token and the caller none", () => {
    const env = brokerChildEnv({ GH_TOKEN: TOKEN, PATH: "/usr/bin", PAPERCLIP_GITHUB_BROKER_SOCKET: "/s" }, {});
    expect(env.GH_TOKEN).toBe(TOKEN);
    // Cleared so a child cannot dial the broker from inside the broker.
    expect(env.PAPERCLIP_GITHUB_BROKER_SOCKET).toBeUndefined();
    expect(env.PAPERCLIP_GITHUB_BROKER_ROLE).toBe("server");
    // Nothing from the CALLER is here: the request carries no environment at
    // all, so this is an allowlist over the BROKER's own environment.
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("runs the shipped wrapper, never a path the request chose", () => {
    const prepared = prepareBrokeredInvocation({
      request: { v: 1, tool: "git", argv: ["push"], cwd: workspaceRoot },
      workspaceRoot,
      wrapperDir,
      env: {},
      realpath: (p) => p,
    });
    expect(prepared.command).toBe(path.join(wrapperDir, "git"));
    expect(prepared.argv).toContain("protocol.allow=never");
    expect(prepared.argv).toContain(`safe.directory=${workspaceRoot}`);
  });

  it("gives gh a fresh config directory, so no alias survives an invocation", () => {
    const made: string[] = [];
    const prepared = prepareBrokeredInvocation({
      request: { v: 1, tool: "gh", argv: ["pr", "list"], cwd: workspaceRoot },
      workspaceRoot,
      wrapperDir,
      env: {},
      realpath: (p) => p,
      makeTempDir: () => {
        const dir = path.join(workdir, `gh-config-${made.length}`);
        made.push(dir);
        return dir;
      },
    });
    expect(prepared.env.GH_CONFIG_DIR).toBe(made[0]);
  });

  it("end to end: the child publishes with the token, the caller sees only its output", async () => {
    // Stands in for the real `git` wrapper. It proves the child HAS the
    // credential (so the publish is really performed with one) without the
    // broker ever sending the credential itself.
    writeFakeTool("git", 'if [ -n "$GH_TOKEN" ]; then echo "authenticated"; else echo "no credential"; fi; echo "argv: $*"');
    const socketPath = await start();
    const result = await call(socketPath, "git", ["push", "origin", "HEAD"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("authenticated");
    expect(result.stdout).toContain("push origin HEAD");
    // The token value itself never crosses the socket.
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).not.toContain(TOKEN);
  });

  it("end to end: relays stdin, stdout and a non-zero exit", async () => {
    writeFakeTool("gh", 'cat; echo "on stderr" >&2; exit 7');
    const socketPath = await start();
    const stdout: Buffer[] = [];
    const stdin = new PassThrough();
    stdin.write("body text");
    stdin.end();
    const code = await runPublishBrokerClient({
      socketPath,
      tool: "gh",
      argv: ["pr", "comment"],
      cwd: workspaceRoot,
      stdin,
      stdout: collect(stdout),
      stderr: collect([]),
    });
    expect(code).toBe(7);
    expect(Buffer.concat(stdout).toString("utf8")).toBe("body text");
  });

  it("end to end: refuses `git credential fill`, the shortest route back to the token", async () => {
    writeFakeTool("git", 'echo "SHOULD NOT RUN: $*"');
    const socketPath = await start();
    const result = await call(socketPath, "git", ["credential", "fill"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("SHOULD NOT RUN");
    expect(result.stderr).toMatch(/performs pushes/);
  });

  it("end to end: refuses `gh auth token`", async () => {
    writeFakeTool("gh", 'echo "$GH_TOKEN"');
    const socketPath = await start();
    const result = await call(socketPath, "gh", ["auth", "token"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stderr).toMatch(/refusing `gh auth`/);
  });

  it("end to end: refuses a working directory outside the workspace", async () => {
    writeFakeTool("git", "echo ran");
    const socketPath = await start();
    const stderr: Buffer[] = [];
    const stdin = new PassThrough();
    stdin.end();
    const code = await runPublishBrokerClient({
      socketPath,
      tool: "git",
      argv: ["push"],
      cwd: wrapperDir, // inside the broker's reach, outside the workspace
      stdin,
      stdout: collect([]),
      stderr: collect(stderr),
    });
    expect(code).not.toBe(0);
    expect(Buffer.concat(stderr).toString("utf8")).toMatch(/outside the shared workspace/);
  });
});
