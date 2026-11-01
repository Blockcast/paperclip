// PEN-4933 / PEN-3183 D1: the broker. This is the process that holds the
// GitHub push credential.
//
// It runs in its own container, at a uid that is not the agent's, with the
// token Secret mounted into that container and NOT into the agent's. The agent
// reaches it over a unix socket on a shared `emptyDir` and asks it to perform a
// publish. It never asks for, and this process never returns, a token.
//
// ## What this is, and what it is not
//
// It IS the boundary PEN-3183 D1 decided on: the credential sits behind a
// container boundary rather than behind a file mode, so "call /usr/bin/git
// directly" stops being a publish path and becomes an authentication failure.
//
// It is NOT a sandbox. The broker runs git and gh against a repository that
// belongs to the agent, so the agent chooses some of the input this process
// reads. {@link admitInvocation} closes the enumerated routes from that input
// back to the credential; the residual is recorded in §7.3 of the decision
// document rather than papered over. Do not describe this as tamper-resistant
// (§8 prohibits exactly that).
//
// ## One definition per door
//
// The broker does not re-implement any door. For each tool it execs the SAME
// image wrapper the agent would have run, with {@link BROKER_ROLE_ENV} set so
// that the wrapper's runtime performs the work locally instead of forwarding
// again. So the scan that decides what a push may contain is the existing
// pre-push hook, reached through the existing runtime, using the existing
// `scrubGitHubEgressText` — which is what keeps `github-egress-door-parity`
// true. PEN-3183 §8 forbids a broker with its own notion of what a push may
// contain, and the way this avoids having one is by not containing one.

import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { EGRESS_GUARD_BIN_DIR } from "./egress-guard-path.js";
import { scrubGitHubEgressText } from "./github-egress-scrub.js";

import {
  BROKER_ROLE_ENV,
  BROKER_ROLE_SERVER,
  BROKER_SOCKET_ENV,
} from "./github-publish-broker-client.js";
import {
  admitCallerFilePaths,
  admitInvocation,
  brokerGitConfigForCwd,
  PublishBrokerRefusal,
  resolveBrokerCwd,
} from "./github-publish-broker-policy.js";
import {
  ClientFrameKind,
  createFrameReader,
  encodeFrame,
  parsePublishBrokerRequest,
  ServerFrameKind,
  type BrokeredTool,
  type PublishBrokerRequest,
} from "./github-publish-broker-protocol.js";

/**
 * Where the image installs the wrappers the broker re-enters.
 *
 * PEN-5030: re-exported from `./egress-guard-path.js` rather than declared
 * here, so the same directory the broker re-enters is the one the PATH-guard
 * helpers refuse to drop. One literal, two readers.
 */
export const IMAGE_WRAPPER_DIR = EGRESS_GUARD_BIN_DIR;

/**
 * The shared `/tmp`, mounted in BOTH containers.
 *
 * It is the authored-text channel: `gh --body-file /tmp/x.md` is how an agent
 * hands the broker text to publish, and the broker has to read that file
 * rather than trust a verdict computed at uid 1000 (PEN-3183 §5). So it is the
 * one directory outside the workspace whose contents a brokered tool may read.
 */
export const SHARED_TMP_DIR = "/tmp";

/**
 * A scratch directory mounted ONLY in the broker container.
 *
 * The `gh` config directory must live here and not under {@link
 * SHARED_TMP_DIR}. An ephemeral `GH_CONFIG_DIR` is half of what makes the
 * `gh` denylist acceptable (see `REFUSED_GH_SUBCOMMANDS`) — `alias` and
 * `extension` are refused AND have nothing to execute from. That second half
 * only holds if the agent cannot write the directory `gh` is about to read.
 * `mkdtemp` under a shared `/tmp` does not give that: the directory it creates
 * is 0700 and owned by the broker, but its PARENT is an `emptyDir` the agent
 * can write, and a directory entry can be renamed away and replaced by anyone
 * who can write the parent. Kubernetes does not set the sticky bit on an
 * `emptyDir`, so nothing stops that — the agent substitutes its own config
 * directory, `gh` reads an alias out of it, and the broker executes shell
 * beside the credential.
 *
 * Container-scoped, like the credential mount itself: what makes this
 * unreachable at uid 1000 is that it is not in the agent's mount namespace,
 * not its mode (§7.3.2 makes the same point about the token).
 *
 * ⚠ Under `/var/lib`, deliberately NOT under `/run`. `/var/run` is a symlink
 * to `/run` on the Debian-derived runtime image (verified on the image this
 * ships in), and the shared socket directory — which the agent DOES mount —
 * is `/var/run/paperclip-github-broker`. A private directory at
 * `/run/paperclip-github-broker` would therefore resolve to that exact same
 * directory and would be agent-writable, which is the one property this
 * constant exists to deny. The Job builder's mount-shadowing backstop
 * compares literal paths and would not catch it.
 */
export const BROKER_PRIVATE_DIR = "/var/lib/paperclip-github-broker";

/**
 * Environment variables the broker's children keep from the broker's own
 * environment.
 *
 * An allowlist, and a short one. The broker's environment contains the token
 * (`paperclip-github-token-env` exports it before exec'ing this process), so
 * the question "what does a child inherit" is the question "what else can see
 * the credential". Children here ARE the credential-bearing binaries, so they
 * get it — but nothing is carried through from the CALLER, whose environment
 * never crosses the socket at all (see `PublishBrokerRequest`).
 */
const INHERITED_ENV_NAMES = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_OPTIONS",
  "PAPERCLIP_HOME",
  "PAPERCLIP_GITHUB_TOKEN_FILE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
] as const;

export interface PublishBrokerServerOptions {
  socketPath: string;
  /** Root the request `cwd` must resolve under; the shared workspace volume. */
  workspaceRoot: string;
  /**
   * Broker-private scratch. Overridden in tests ONLY — production takes
   * {@link BROKER_PRIVATE_DIR}, and there is deliberately no environment
   * variable for it: a misconfiguration that pointed this at the shared `/tmp`
   * would silently undo the `gh` config-dir guarantee, and the one thing a
   * boundary must not be is quietly configurable into being absent.
   */
  privateDir?: string;
  /** Overridden in tests. Production uses {@link IMAGE_WRAPPER_DIR}. */
  wrapperDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Overridden in tests so a fake tool can stand in for git/gh. */
  spawnChild?: typeof spawn;
  log?: (message: string) => void;
}

/**
 * Build the environment for a brokered child.
 *
 * Exported for the test that asserts the broker hands a child a token and hands
 * the AGENT nothing — the two halves of "performs the publish, never emits the
 * credential".
 */
export function brokerChildEnv(
  brokerEnv: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV_NAMES) {
    const value = brokerEnv[name];
    if (value !== undefined) env[name] = value;
  }
  // Never let a child prompt. Without this a push whose credential helper
  // declined would block on a terminal read that will never be answered, and
  // the agent would see a hung command rather than a refusal.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env[BROKER_ROLE_ENV] = BROKER_ROLE_SERVER;
  // Deliberately cleared, not forwarded: a child that re-read this would dial
  // the broker from inside the broker.
  delete env[BROKER_SOCKET_ENV];
  return { ...env, ...extra };
}

interface PreparedInvocation {
  command: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

/**
 * Turn an admitted request into the exact child the broker will run.
 *
 * Exported so a test can assert the shape — the argv git actually receives, the
 * ephemeral `gh` config directory, and the fact that the command is the shipped
 * wrapper rather than a path the request chose.
 */
export function prepareBrokeredInvocation(options: {
  request: PublishBrokerRequest;
  workspaceRoot: string;
  wrapperDir: string;
  env: NodeJS.ProcessEnv;
  realpath?: (p: string) => string;
  makeTempDir?: () => string;
  /** Overridden in tests. Production is the workspace plus the shared `/tmp`. */
  allowedFileRoots?: readonly string[];
  /** Overridden in tests. Production is {@link BROKER_PRIVATE_DIR}. */
  privateDir?: string;
}): PreparedInvocation {
  const realpath = options.realpath ?? realpathSync;
  const cwd = resolveBrokerCwd(options.request.cwd, options.workspaceRoot, realpath);
  // Before admission and before injection, because this rule is about the
  // CALLER's argv: the broker's own `credential.helper` assignment names a
  // real path in the image, outside every allowed root, and is not input.
  admitCallerFilePaths(options.request.argv, {
    allowedRoots: options.allowedFileRoots ?? [options.workspaceRoot, SHARED_TMP_DIR],
    cwd,
    realpath,
  });
  const admitted = admitInvocation(options.request.tool, options.request.argv);

  const extraEnv: Record<string, string> = {};
  let cleanup = (): void => {};

  let argv = admitted;
  if (options.request.tool === "git") {
    argv = [...brokerGitConfigForCwd(cwd).flatMap((assignment) => ["-c", assignment]), ...admitted];
  }
  if (options.request.tool === "gh") {
    // A fresh, empty config directory per invocation. `gh` reads aliases,
    // extensions and `hosts.yml` from here; an empty one means there is no
    // alias to execute and no stored credential to find, and because it is
    // per-invocation nothing a previous request wrote can persist into the
    // next. Paired with the `alias`/`extension` refusals in the admission
    // policy — neither is load-bearing alone.
    //
    // Created under {@link BROKER_PRIVATE_DIR}, NOT under `TMPDIR`/`os.tmpdir()`.
    // Those both resolve to the shared `/tmp` in the deployed pod, whose parent
    // the agent can write — and a 0700 directory inside a writable parent can
    // be renamed away and replaced. See the constant for why that would undo
    // the pairing above outright.
    const privateDir = options.privateDir ?? BROKER_PRIVATE_DIR;
    const makeTempDir =
      options.makeTempDir ??
      (() => {
        mkdirSync(privateDir, { recursive: true, mode: 0o700 });
        return mkdtempSync(path.join(privateDir, "gh-"));
      });
    const configDir = makeTempDir();
    extraEnv.GH_CONFIG_DIR = configDir;
    cleanup = () => rmSync(configDir, { recursive: true, force: true });
  }

  return {
    // The command is NEVER taken from the request. `tool` is one of three
    // literals validated by the protocol parser, and it is joined onto the
    // image's own wrapper directory here — so there is no argument the agent
    // can supply that selects which binary the credential-holding process runs.
    command: path.join(options.wrapperDir, options.request.tool),
    argv,
    cwd,
    env: brokerChildEnv(options.env, extraEnv),
    cleanup,
  };
}

/**
 * How a brokered connection ended, as a closed set.
 *
 * PEN-5185. §5.3 of the enablement plan asks the soak for a query separating
 * (a) startup failures, (b) policy refusals and (c) child non-zero exits. Until
 * this existed the broker reported every OUTCOME to the socket — back to the
 * agent — and wrote only its INPUTS to its own stderr, so (c) was not quiet,
 * it was structurally absent, and a dashboard panel for it printed `0` forever.
 * `0` and "no child ever failed" are byte-identical, which is the exact
 * confusion §5.3 exists to prevent.
 *
 * A closed set rather than free text because the query has to PARTITION the
 * stream: a line that matches no category and a category that counts no line
 * are the same reading mistake one level up.
 */
export type PublishBrokerOutcome =
  /** The child ran and exited. `code` is its own exit status. */
  | "exit"
  /** The child never started — exec failed. The tool did no work at all. */
  | "spawn-failed"
  /** The broker refused, before or instead of running anything. */
  | "refused";

/**
 * The one line the broker writes about how a connection ended.
 *
 * ⛔ **It carries the exit code and the tool name. It never carries the child's
 * bytes.** The broker's stderr reaches Loki, which outlives the pod's
 * `ttlSecondsAfterFinished: 300` — so relaying `git`/`gh` output here would
 * turn an observability fix into a durable credential-disclosure path (a push
 * URL can embed a token). `child.stderr` stays socket-only, which is where the
 * agent that asked for the publish already reads it.
 *
 * `refused` carries its reason because that text is the broker's own prose, not
 * the child's. It is still passed through {@link scrubGitHubEgressText} first:
 * several refusals interpolate caller argv (a `-c` spelling, a `cwd`, a path
 * token), and this is the same scrubber the push door itself uses — one
 * definition of what may leave, as the header comment requires. The agent's
 * copy over the socket is deliberately NOT scrubbed or collapsed: it is the
 * diagnostic, and it never leaves the pod.
 *
 * `refused` and `exit` are spelled differently on purpose. `refuse` defaults to
 * code 64 and a child can genuinely return 64, so the code alone cannot
 * separate them — the verb is what the query anchors on.
 *
 * The detail is capped at {@link MAX_OUTCOME_DETAIL_CHARS}. It is caller-
 * controlled up to `MAX_REQUEST_BYTES` (1 MiB) — `unknown tool
 * ${JSON.stringify(candidate.tool)}` echoes whatever JSON arrived — so without
 * a cap one refusal can emit a one-megabyte Loki line, and `sendExit` is now
 * the single chokepoint every connection passes through.
 */
export function formatBrokerOutcomeLine(fields: {
  outcome: PublishBrokerOutcome;
  tool: BrokeredTool | null;
  code: number;
  detail?: string;
}): string {
  // `-` when the connection was refused before a request was parsed: there is
  // no tool, and naming one would invent a door that was never asked for.
  const parts = [`paperclip-github-broker: ${fields.outcome} ${fields.tool ?? "-"} code=${fields.code}`];
  if (fields.detail !== undefined) {
    // Collapsed to one physical line: the partition check counts LINES, so a
    // multi-line reason would read as several uncategorised entries.
    //
    // The emptiness test is on the SCRUBBED text, and that one test is enough:
    // an empty input and an input that was entirely whitespace both land here
    // as "", so a second guard on the raw value is unreachable (mutating it
    // alone kills no test, because this line already covers it).
    const scrubbed = scrubGitHubEgressText(fields.detail).text.replace(/\s+/g, " ").trim();
    if (scrubbed !== "") parts.push(`detail=${truncateOutcomeDetail(scrubbed)}`);
  }
  return parts.join(" ");
}

/**
 * The cap on a refusal reason, in characters.
 *
 * Sized by measurement, not by taste: the longest refusal the policy module can
 * author is 341 characters of static prose, and the interpolating ones add a
 * `cwd`, a resolved path and a roots list on top. 1024 keeps every legitimate
 * refusal whole — the reason is the security-relevant half of the line, since a
 * bare count cannot separate a client stutter from an attempted policy bypass —
 * while bounding the caller-controlled case from 1 MiB to 1 KiB.
 */
export const MAX_OUTCOME_DETAIL_CHARS = 1024;

/**
 * Spelled so it cannot be confused with {@link redactionMarker}'s output. A
 * reader who sees a cut-off line has to be able to tell "the rest was too long"
 * from "the rest was a credential"; collapsing those two into one marker would
 * make a scrub look like a length accident.
 */
export const OUTCOME_DETAIL_TRUNCATION_MARKER = "[paperclip-github-broker: detail truncated]";

/**
 * ⚠ Truncation happens AFTER the scrub, and the order is the security property
 * — not a style choice.
 *
 * Cutting first can sever a credential below the length its detector matches
 * on, so the scrubber then finds nothing and the surviving prefix is emitted
 * verbatim: a token that straddles the cap would leak its first bytes into a
 * log that outlives the pod. Scrubbing first replaces the whole token with a
 * marker, and only then is the (now safe) text cut to length.
 */
function truncateOutcomeDetail(scrubbed: string): string {
  if (scrubbed.length <= MAX_OUTCOME_DETAIL_CHARS) return scrubbed;
  return `${scrubbed.slice(0, MAX_OUTCOME_DETAIL_CHARS)}${OUTCOME_DETAIL_TRUNCATION_MARKER}`;
}

export interface PublishBrokerServer {
  /** The listening socket path. */
  socketPath: string;
  close(): Promise<void>;
}

export function createPublishBrokerServer(options: PublishBrokerServerOptions): Promise<PublishBrokerServer> {
  const env = options.env ?? process.env;
  const wrapperDir = options.wrapperDir ?? IMAGE_WRAPPER_DIR;
  const spawnChild = options.spawnChild ?? spawn;
  const log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));

  const privateDir = options.privateDir ?? BROKER_PRIVATE_DIR;
  const server = net.createServer((socket) => {
    handleConnection({ socket, env, wrapperDir, spawnChild, workspaceRoot: options.workspaceRoot, privateDir, log });
  });

  return new Promise<PublishBrokerServer>((resolve, reject) => {
    mkdirSync(path.dirname(options.socketPath), { recursive: true });
    // A stale socket file survives a crash and makes `listen` fail with
    // EADDRINUSE on restart — which, for a sidecar that restarts, would be a
    // permanent outage of all three doors after one bad exit.
    try {
      unlinkSync(options.socketPath);
    } catch {
      /* nothing to remove */
    }
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      // The agent container connects as a different uid, so the socket has to
      // admit it. This grants CONNECT, which is the whole of the authority this
      // boundary intends to hand over: what may then be asked for is decided by
      // the admission policy, not by who may open the socket.
      chmodSync(options.socketPath, 0o666);
      server.removeListener("error", reject);
      resolve({
        socketPath: options.socketPath,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function handleConnection(ctx: {
  socket: net.Socket;
  env: NodeJS.ProcessEnv;
  wrapperDir: string;
  workspaceRoot: string;
  privateDir: string;
  spawnChild: typeof spawn;
  log: (message: string) => void;
}): void {
  const { socket } = ctx;
  const read = createFrameReader();
  let request: PublishBrokerRequest | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let finished = false;

  // One chokepoint, so there is exactly one outcome line per connection and no
  // path off this process that reports a result without being counted.
  // `child.on("error")` and `child.on("close")` both funnel through here, which
  // is what makes (c) and spawn failure one place rather than two.
  const sendExit = (code: number, outcome: PublishBrokerOutcome = "exit", detail?: string) => {
    if (finished) return;
    finished = true;
    // ⚠ The EXIT frame goes FIRST, and the log is wrapped. Both halves matter,
    // and neither is defensive decoration.
    //
    // `finished` latches above, so there is no second attempt at either side
    // effect. Every caller of this — the `socket.on("data")` handler,
    // `child.on("close")`, `child.on("error")` — is an EventEmitter callback
    // with no `try` above it, so a throw escaping here is an
    // `uncaughtException`: it does not fail this connection, it kills the
    // broker process, and with it every publish for the remaining life of the
    // Job. The default `ctx.log` is `process.stderr.write`, which throws on a
    // broken pipe, and `formatBrokerOutcomeLine` runs the scrubber's whole
    // regex battery — so this is a reachable throw, not a theoretical one.
    //
    // §6's rollback standard is the other half: "a Job that never renders is
    // indistinguishable from 'the broker broke dispatch'". A dead sidecar is
    // exactly that shape, so it must not be reachable from a log failure.
    //
    // Ordering is belt and braces for the same hazard: the client's exit must
    // not be downstream of the log even if the guard below is ever removed.
    // The log reaching Loki after the socket closed costs nothing — the
    // partition counts lines, not their arrival order.
    socket.end(encodeFrame(ServerFrameKind.EXIT, JSON.stringify({ code })));
    try {
      ctx.log(formatBrokerOutcomeLine({ outcome, tool: request?.tool ?? null, code, detail }));
    } catch {
      // Deliberately silent: the thing that failed IS the way this process
      // reports. The loss is not invisible — the §5.3 partition compares accept
      // lines against outcome lines, and a dropped outcome shows up there as an
      // imbalance rather than as a miscount inside a category.
    }
  };
  const refuse = (message: string, code = 64) => {
    if (finished) return;
    socket.write(encodeFrame(ServerFrameKind.STDERR, `${message}\n`));
    // The agent's copy is written above, unscrubbed and unwrapped. The log copy
    // goes through `sendExit` so a refusal cannot be counted twice, and so the
    // four protocol refusals that never touched the policy module are observable
    // for the first time.
    sendExit(code, "refused", message);
  };

  socket.on("error", () => {
    child?.kill("SIGTERM");
  });

  socket.on("data", (chunk: Buffer) => {
    let frames;
    try {
      frames = read(chunk);
    } catch (error) {
      refuse(`paperclip-github-broker: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const frame of frames) {
      if (frame.kind === ClientFrameKind.REQUEST) {
        if (request) {
          refuse("paperclip-github-broker: a second request on one connection; one publish per connection");
          return;
        }
        try {
          request = parsePublishBrokerRequest(frame.payload);
          child = startChild(ctx, request, socket, sendExit);
        } catch (error) {
          const message =
            error instanceof PublishBrokerRefusal
              ? error.message
              : `paperclip-github-broker: ${error instanceof Error ? error.message : String(error)}`;
          // No `ctx.log` here: `refuse` logs. Logging in both places made every
          // policy refusal two Loki lines and one socket frame, which no
          // partition can balance.
          refuse(message);
          return;
        }
        continue;
      }
      if (!child) {
        refuse("paperclip-github-broker: stdin arrived before a request");
        return;
      }
      if (frame.kind === ClientFrameKind.STDIN) {
        child.stdin?.write(frame.payload);
        continue;
      }
      if (frame.kind === ClientFrameKind.STDIN_EOF) {
        child.stdin?.end();
        continue;
      }
      refuse(`paperclip-github-broker: unknown frame kind 0x${frame.kind.toString(16)}`);
      return;
    }
  });

  socket.on("close", () => {
    // The agent went away mid-publish. Kill the child rather than letting it
    // finish: its output has nowhere to go, and a push whose result nobody
    // reads is worse than one that did not happen.
    child?.kill("SIGTERM");
  });
}

function startChild(
  ctx: {
    env: NodeJS.ProcessEnv;
    wrapperDir: string;
    workspaceRoot: string;
    privateDir: string;
    spawnChild: typeof spawn;
    log: (message: string) => void;
  },
  request: PublishBrokerRequest,
  socket: net.Socket,
  sendExit: (code: number, outcome?: PublishBrokerOutcome, detail?: string) => void,
): ReturnType<typeof spawn> {
  const prepared = prepareBrokeredInvocation({
    request,
    workspaceRoot: ctx.workspaceRoot,
    wrapperDir: ctx.wrapperDir,
    privateDir: ctx.privateDir,
    env: ctx.env,
  });
  ctx.log(`paperclip-github-broker: ${request.tool} in ${prepared.cwd}`);

  const child = ctx.spawnChild(prepared.command, prepared.argv, {
    cwd: prepared.cwd,
    env: prepared.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => socket.write(encodeFrame(ServerFrameKind.STDOUT, data)));
  child.stderr?.on("data", (data: Buffer) => socket.write(encodeFrame(ServerFrameKind.STDERR, data)));
  child.on("error", (error: NodeJS.ErrnoException) => {
    prepared.cleanup();
    socket.write(
      encodeFrame(
        ServerFrameKind.STDERR,
        `paperclip-github-broker: unable to start ${request.tool} (${error.code ?? error.message})\n`,
      ),
    );
    // Its own outcome, not an `exit` of 1: the tool never ran, so counting it
    // as a child failure would overstate (c) and hide the class §5.3 does not
    // name at all. `error.code` is Node's own (`ENOENT`, `EACCES`), not child
    // output.
    sendExit(1, "spawn-failed", error.code ?? error.message);
  });
  child.on("close", (code, signal) => {
    prepared.cleanup();
    sendExit(code ?? (signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1));
  });
  return child;
}

export type { BrokeredTool };
