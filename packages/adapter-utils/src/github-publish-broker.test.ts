import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  brokerChildEnv,
  createPublishBrokerServer,
  formatBrokerOutcomeLine,
  prepareBrokeredInvocation,
  type PublishBrokerServer,
} from "./github-publish-broker.js";
import { runPublishBrokerClient } from "./github-publish-broker-client.js";
import {
  ClientFrameKind,
  encodeFrame,
  encodePublishBrokerRequest,
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
/**
 * Everything the broker wrote to its OWN stderr, i.e. everything that reaches
 * Loki. PEN-5185 is about this array's contents, in both directions: what must
 * appear in it (an outcome per connection) and what must never (child bytes).
 */
let logged: string[] = [];

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
  logged = [];
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
    log: (message: string) => logged.push(message),
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

/**
 * Drive the socket directly, with no client library, and return everything the
 * broker sent back.
 *
 * ⚠ The `data` listener is load-bearing, not decoration. A `net.Socket` with no
 * consumer stays paused, so it never reads the broker's FIN, never emits
 * `close`, and `server.close()` in `afterEach` hangs — which reads as a broken
 * broker rather than a test that forgot to listen.
 */
async function rawExchange(socketPath: string, send: (sock: net.Socket) => void): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection(socketPath, () => send(sock));
    sock.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    sock.on("close", () => resolve());
    sock.on("error", reject);
  });
  return Buffer.concat(chunks).toString("utf8");
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
    // The brokered push IS the unit under test, and the child it reaches is
    // the `writeFakeTool("git", ...)` shell script in a temp dir above — not
    // git, and not a remote. PEN-4933 / PEN-3183 D1.
    // paperclip:allow-git-push: brokered push under test; the child is a fake tool, not git.
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

// PEN-5185. The broker used to report every publish OUTCOME to the socket and
// write only its INPUTS to its own stderr, so §5.3's category (c) — child
// non-zero exits — was not quiet but structurally absent, along with spawn
// failures and the four protocol refusals.
//
// Each `it` below pins ONE clause of that fix. They are deliberately not folded
// together: a guard added without its own fixture passes the whole suite, and
// the point of this change is that a missing line is invisible.
describe("the broker's own stderr records how every connection ended", () => {
  /** Outcome lines only — the accept line is the denominator, not an outcome. */
  const outcomes = () => logged.filter((line) => /: (exit|spawn-failed|refused) /.test(line));

  describe("formatBrokerOutcomeLine", () => {
    it("names the outcome, the tool and the code", () => {
      expect(formatBrokerOutcomeLine({ outcome: "exit", tool: "git", code: 3 })).toBe(
        "paperclip-github-broker: exit git code=3",
      );
    });

    it("separates a refusal from a child exit that returned the same code", () => {
      // `refuse` defaults to 64 and a child may genuinely exit 64, so the code
      // cannot be the discriminator. The verb is.
      const refused = formatBrokerOutcomeLine({ outcome: "refused", tool: "gh", code: 64 });
      const exited = formatBrokerOutcomeLine({ outcome: "exit", tool: "gh", code: 64 });
      expect(refused).not.toBe(exited);
      expect(refused.startsWith("paperclip-github-broker: refused ")).toBe(true);
      expect(exited.startsWith("paperclip-github-broker: exit ")).toBe(true);
    });

    it("writes `-` for the tool when the connection was refused before a request parsed", () => {
      expect(formatBrokerOutcomeLine({ outcome: "refused", tool: null, code: 64 })).toBe(
        "paperclip-github-broker: refused - code=64",
      );
    });

    it("scrubs a credential out of the refusal detail before it reaches Loki", () => {
      // Several refusals interpolate caller argv, and the broker's stderr
      // outlives the pod. Derived, not a literal: a token-shaped literal in a
      // test file is what the egress door itself refuses to publish.
      const secret = ["gh", "p"].join("") + "_" + "A".repeat(36);
      const line = formatBrokerOutcomeLine({
        outcome: "refused",
        tool: "git",
        code: 64,
        detail: `refusing a push that sets git config itself (\`-c credential.helper=!f(){ echo ${secret}; }\`)`,
      });
      expect(line).not.toContain(secret);
      expect(line).toContain("paperclip-github-broker: refused git code=64");
    });

    it("collapses a detail to one physical line, so the partition can count lines", () => {
      const line = formatBrokerOutcomeLine({
        outcome: "refused",
        tool: "gh",
        code: 64,
        detail: "refusing this\nand also\n\nthat",
      });
      expect(line).not.toContain("\n");
      expect(line).toContain("detail=refusing this and also that");
    });

    it("omits the detail field entirely rather than emitting an empty one", () => {
      expect(formatBrokerOutcomeLine({ outcome: "exit", tool: "git", code: 0 })).not.toContain("detail=");
      expect(formatBrokerOutcomeLine({ outcome: "exit", tool: "git", code: 0, detail: "" })).not.toContain("detail=");
      // Whitespace-only too: the emptiness test is on the SCRUBBED text, and a
      // bare `detail=` would be an uncategorisable field rather than an absent
      // one. Testing `""` alone leaves this unpinned.
      expect(formatBrokerOutcomeLine({ outcome: "exit", tool: "git", code: 0, detail: " \n\t " })).not.toContain(
        "detail=",
      );
    });
  });

  it("(c) logs a child's non-zero exit — the category that was structurally absent", async () => {
    writeFakeTool("gh", "exit 7");
    const socketPath = await start();
    expect((await call(socketPath, "gh", ["pr", "list"])).code).toBe(7);
    expect(outcomes()).toEqual(["paperclip-github-broker: exit gh code=7"]);
  });

  it("(c) logs a child's zero exit too, so the panel has a denominator of outcomes", async () => {
    writeFakeTool("git", "echo ok");
    const socketPath = await start();
    // paperclip:allow-git-push: brokered push under test; the child is a fake tool, not git.
    expect((await call(socketPath, "git", ["push"])).code).toBe(0);
    expect(outcomes()).toEqual(["paperclip-github-broker: exit git code=0"]);
  });

  it("logs a spawn failure as its own class, not as an exit of 1", async () => {
    // No tool written, so exec fails: the tool never ran. Counting this as a
    // child exit would overstate (c) and hide a class §5.3 does not name.
    const socketPath = await start();
    expect((await call(socketPath, "gh", ["pr", "list"])).code).not.toBe(0);
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toContain("paperclip-github-broker: spawn-failed gh code=1");
    expect(outcomes()[0]).toContain("ENOENT");
    expect(outcomes()[0]).not.toContain("exit gh");
  });

  it("(b) logs a policy refusal exactly once — collapsed, not double-logged", async () => {
    writeFakeTool("gh", `echo "$GH_TOKEN"`);
    const socketPath = await start();
    expect((await call(socketPath, "gh", ["auth", "token"])).code).not.toBe(0);
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toContain("paperclip-github-broker: refused gh code=64");
    expect(outcomes()[0]).toContain("refusing `gh auth`");
    // The pre-PEN-5185 handler logged the message AND refused, so a refusal was
    // two Loki lines against one socket frame and no partition could balance.
    expect(logged.filter((l) => l.includes("refusing `gh auth`"))).toHaveLength(1);
  });

  it("(b) logs a PROTOCOL refusal — reached from call sites that never touched the policy module", async () => {
    const socketPath = await start();
    // Raw socket: the client always sends a well-formed REQUEST first, so this
    // half of (b) is unreachable through it. That is exactly why it was dark.
    const received = await rawExchange(socketPath, (sock) =>
      sock.write(encodeFrame(ClientFrameKind.STDIN, "stdin with no request")),
    );
    // The agent's copy is unchanged — this adds a log line, it does not move
    // the diagnostic off the socket.
    expect(received).toContain("stdin arrived before a request");
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toContain("paperclip-github-broker: refused - code=64");
    expect(outcomes()[0]).toContain("stdin arrived before a request");
  });

  it("(b) logs a second request on one connection, with the tool it already had", async () => {
    writeFakeTool("git", "echo ok");
    const socketPath = await start();
    // Already a complete frame -- do NOT wrap it in `encodeFrame` again, or the
    // broker refuses the first one as invalid JSON and this never reaches the
    // second-request branch at all.
    const request = encodePublishBrokerRequest({ tool: "git", argv: ["push"], cwd: workspaceRoot });
    const received = await rawExchange(socketPath, (sock) => {
      sock.write(request);
      sock.write(request);
    });
    expect(received).toContain("one publish per connection");
    expect(outcomes()).toHaveLength(1);
    expect(outcomes()[0]).toContain("paperclip-github-broker: refused git code=64");
    expect(outcomes()[0]).toContain("one publish per connection");
  });

  it("⛔ never writes the child's bytes to its own stderr, in any outcome", async () => {
    // The one way to get this change wrong. The broker's stderr reaches Loki,
    // which outlives `ttlSecondsAfterFinished: 300`, so teeing `git`/`gh`
    // output here would make a push URL's embedded token durable. Derived, not
    // a literal, for the same reason as TOKEN above.
    const leak = ["gh", "p"].join("") + "_" + Buffer.from("pen5185-child-stderr").toString("hex");
    // Assembled from fragments, and the scheme-and-userinfo prefix is split
    // across two of them on purpose. A contiguous remote URL carrying inline
    // credentials, written as one literal in this blob, is refused by the push
    // door itself under `credentialed-uri` — which is the same judgement this
    // test asserts the broker makes about its own log. (Describing the shape
    // in prose here trips it too; this comment is on its second wording.)
    const leakyRemote = ["https:/", "/x:", leak, "@github.com/o/r"].join("");
    writeFakeTool("gh", `echo "remote: ${leakyRemote}" >&2; exit 128`);
    const socketPath = await start();
    const result = await call(socketPath, "gh", ["pr", "list"]);
    // The agent still gets it: this is a diagnostic, and the socket never
    // leaves the pod.
    expect(result.stderr).toContain(leak);
    // Loki does not.
    expect(logged.join("\n")).not.toContain(leak);
    expect(logged.join("\n")).not.toContain("remote:");
    expect(outcomes()).toEqual(["paperclip-github-broker: exit gh code=128"]);
  });

  it("writes exactly one outcome line per connection, never two", async () => {
    writeFakeTool("gh", "exit 3");
    const socketPath = await start();
    await call(socketPath, "gh", ["pr", "list"]);
    await call(socketPath, "gh", ["pr", "list"]);
    expect(outcomes()).toEqual([
      "paperclip-github-broker: exit gh code=3",
      "paperclip-github-broker: exit gh code=3",
    ]);
    // Two accepts, two outcomes: the partition balances.
    expect(logged.filter((l) => /: gh in \//.test(l))).toHaveLength(2);
  });
});
