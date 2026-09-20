// PEN-3156: process wrapper for the `git` egress door.
//
// SCOPE — this is an ACCIDENTAL-DISCLOSURE guard. It is not a tamper-resistant
// boundary and must not be described as one. Every component of it — wrapper,
// hook, and scanner alike — sits on a surface writable by the account it
// guards, so it stops a mistake and does not stop a decision. Enforcement that
// holds against a deliberate bypass does not exist yet; it is tracked as
// PEN-3183 and that, not this file, is the control to cite when asking whether
// an agent can publish a credential on purpose. The reasoning is under THREAT
// MODEL below. Read it before extending, renaming, or relying on any of this.
//
// Two modes, one module, because they must agree about what a push is:
//
//   wrapper   node github-git-egress-runtime.js <git> <argv...>
//             Classifies argv. On a push it closes the hook bypass and points
//             git at the hooks directory below, then execs the real git.
//
//   hook      node github-git-egress-runtime.js --pre-push-hook <remote> <url>
//             Runs as git's pre-push hook. Reads the ref updates git computes on
//             stdin, scans what they would publish, and exits non-zero — which
//             is what aborts the push — naming the commit to amend.
//
// Why a hook rather than scanning in the wrapper: git already resolves
// refspecs, `push.default`, and tracking config to decide what it is about to
// send, and hands that result to the hook as exact `<local sha> <remote sha>`
// pairs. Re-deriving it in the wrapper would mean a second implementation of
// those rules that could disagree with the push actually taking place, and
// disagreeing in the permissive direction is a silent hole.
//
// Why the wrapper is still needed: a hook alone is bypassable with
// `--no-verify`, and `core.hooksPath` has to be injected by something. The
// wrapper is what `git` resolves to on PATH, so it is on the path every
// ordinary invocation takes.
//
// THREAT MODEL — read this before extending the guard, because it bounds what
// any change here can achieve.
//
// What this defends against is an agent that discloses WITHOUT INTENDING TO.
// That is the exposure this control descends from: PEN-2526 was an environment
// dump interpolated into prose by an agent doing its job. Against that, a guard
// on the path the agent actually takes is effective, and every refusal above
// earns its place.
//
// What it does NOT defend against is an agent that sets out to defeat it. In
// the deployed pod, measured 2026-09-11:
//
//   - `/usr/bin/git` is mode 0755 and directly executable. Nothing routes it
//     through this wrapper; the wrapper is reached via PATH, which the caller
//     chooses. No file needs to be written to take that path.
//   - The agent runs as uid 1000 (`node`), and
//     `/opt/paperclip-bundled-adapters` — which holds THIS FILE as compiled
//     JavaScript — is `drwxr-xr-x node node`. The scanner is writable by the
//     account it scans.
//   - `${LOCAL_BIN}/git`, `${PATH_BIN}/git` and the hooks directory are all on
//     the PVC, mounted `fsGroup: 1000`, so they are writable too.
//
// So the hook, the wrapper and the scanner are peers, not layers: an agent able
// to tamper with any one of them can tamper with all three, and does not need
// to tamper with anything to call the real git directly. Do not add integrity
// checks between these components — verifying the hook's content from the
// wrapper, or vice versa, asserts a boundary that does not exist and reads to
// the next person as though tamper-resistance had been established.
//
// Making this door hold against a deliberate bypass is a different change in a
// different place: enforcement off the agent's own machine (a server-side
// pre-receive hook, or egress network policy that forces pushes through a
// proxy). That is PEN-3183 — filed, with the four bypasses enumerated and
// measured, rather than approximated here. It is named rather than gestured at
// on purpose: "filed separately" is a promise a reader cannot check, and an
// uncheckable promise is how a documented limit quietly becomes a forgotten
// one. A control that looks tamper-proof and is not is worse than one whose
// limits are written down and tracked.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALIAS_HOP_LIMIT,
  classifyGitInvocation,
  formatRefusal,
  formatScanFailure,
  gitGlobalOptions,
  parsePrePushInput,
  scanPrePushUpdates,
  type GitAliasBypass,
  type GitReader,
} from "./github-git-egress-shim.js";

/** Where the Helm seed writes the pre-push hook. */
export const DEFAULT_HOOKS_DIR = "/paperclip/.local/share/paperclip-git-hooks";

/** The real git, for the hook's own read-only queries. */
export const DEFAULT_GIT_BINARY = "/usr/bin/git";

/**
 * The hooks directory the deployed entrypoint uses.
 *
 * Takes no arguments, and reads no environment, on purpose. These were once
 * `env`-backed overrides defaulting to the constants, which is an escape hatch
 * in a boundary whose whole job is to be unavoidable: the environment here is
 * agent-controlled, so a publish run with
 * `PAPERCLIP_GIT_EGRESS_HOOKS_DIR=/tmp/empty` aimed `core.hooksPath` at a
 * directory with no hook and proceeded unscanned. The sibling
 * `PAPERCLIP_GIT_EGRESS_GIT` was worse: it aimed the hook's own reader at a
 * binary of the caller's choosing, so a fake git reporting clean output
 * cleared the scan.
 *
 * The test seam that justified them is still there and is strictly better —
 * `runGitEgressRuntime` takes `hooksDir` and `runPrePushHook` takes `runGit` as
 * parameters, so tests inject directly instead of through ambient state.
 */
export function hooksDirectory(): string {
  return DEFAULT_HOOKS_DIR;
}

/** The git binary the deployed entrypoint reads with. See `hooksDirectory`. */
export function gitBinary(): string {
  return DEFAULT_GIT_BINARY;
}

export class GitEgressRuntimeError extends Error {
  constructor(
    message: string,
    readonly exitCode = 64,
  ) {
    super(message);
    this.name = "GitEgressRuntimeError";
  }
}

/**
 * Is SOME executable `pre-push` present at `hooksDir`?
 *
 * Named for what it can observe, not for what the caller wishes it meant. It
 * was `prePushHookInstalled`, and "installed" read at the call site as "the
 * guard is in place" — which is precisely the claim this cannot support and
 * the misreading the threat model exists to prevent. An executable
 * pass-through named `pre-push` satisfies it exactly as well as this scanner
 * does.
 *
 * Pointing `core.hooksPath` at a directory that holds no executable `pre-push`
 * is not an error to git — it runs no hook and the push proceeds. That is the
 * one failure mode this whole door cannot tolerate, and it is silent: nothing
 * in the output distinguishes "scanned and clean" from "never scanned".
 *
 * It matters more now that the directory is a constant rather than an override.
 * `DEFAULT_HOOKS_DIR` hardcodes `/paperclip`, while the seed writes to
 * `{{ .Values.persistence.mountPath }}` — equal in every values file today, but
 * a deployment that changed the mount path would silently publish unscanned.
 * Checking turns that from a hole into a refusal that names the missing file.
 *
 * This is a DEPLOYMENT check, not a tamper check, and the distinction is worth
 * keeping straight: it establishes that a hook is present and executable, not
 * that the hook is this scanner. It cannot establish the latter, and neither
 * could a content or ownership check bolted on beside it — the seed runs
 * `runAsNonRoot: true, runAsUser: 1000`, so it has no way to write a file the
 * agent cannot rewrite, and the scanner's own code is on an agent-writable
 * path regardless. See the threat model at the top of this file.
 */
function prePushHookPresent(hooksDir: string): boolean {
  try {
    accessSync(path.join(hooksDir, "pre-push"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the argv the real git is invoked with.
 *
 * `core.hooksPath` is injected only for a push. Setting it unconditionally
 * would shadow every OTHER hook a repository defines — pre-commit, commit-msg —
 * because a hooks directory holding only `pre-push` makes the rest silently stop
 * running. Scoping the injection to the one command whose hook we supply keeps
 * that blast radius off unrelated workflows.
 *
 * Placement is a security property, not a style choice. Git takes the LAST `-c`
 * given for a key, so injecting at the FRONT lets a caller-supplied
 * `git -c core.hooksPath=/tmp/empty push` override the guard and skip the
 * scanner entirely. The guard therefore goes immediately before the subcommand,
 * after every global option the caller passed, where it is the last value git
 * sees. Measured against git 2.47.3: from that position it also beats
 * `--config-env=core.hooksPath=...`, the case-folded `CORE.HOOKSPATH` spelling,
 * a repository's own `core.hooksPath` config, and `GIT_CONFIG_KEY_*` in the
 * environment.
 */
/**
 * The refusal for an alias-carried bypass.
 *
 * Extracted because it is thrown from two places in {@link buildGitArgv} — once
 * ahead of the not-a-push early return and once after it — and the two must not
 * drift into saying different things about the same finding.
 */
function aliasBypassRefusal(bypass: GitAliasBypass): GitEgressRuntimeError {
  const { alias, expansion, reason, chain } = bypass;

  // Worded separately because this one asserts no bypass: the chain outran the
  // resolver, so what it reaches is simply unknown. Telling the author it
  // "expands to a push that ..." would be a claim the guard cannot make.
  if (reason === "alias-depth") {
    const shown = (chain ?? [alias]).join("` → `");
    return new GitEgressRuntimeError(
      `paperclip-github-egress: refusing to run \`${alias}\` — it is an alias chain deeper than ${ALIAS_HOP_LIMIT} hops (\`${shown}\` → \`${expansion}\`), so this guard stopped resolving before reaching the command git would actually run, and cannot tell whether it publishes. Resolution is bounded on purpose: the config defining the chain is writable from here, so an unbounded walk would be a denial of service. Invoke the underlying command directly, or flatten the alias so it resolves within ${ALIAS_HOP_LIMIT} hops.`,
    );
  }

  const what =
    reason === "no-verify"
      ? "skips the pre-push hook with --no-verify"
      : reason === "hooks-path"
        ? "points core.hooksPath somewhere else"
        : "cannot be parsed the way git parses an alias (unterminated quote), so it cannot be checked for a bypass";
  return new GitEgressRuntimeError(
    `paperclip-github-egress: refusing to publish — the alias \`${alias}\` expands to a push that ${what} (\`${expansion}\`), which would bypass the check for credential-shaped material. Invoke the push directly instead of through the alias, or redefine the alias without it.`,
  );
}

export function buildGitArgv(
  argv: readonly string[],
  options: {
    hooksDir: string;
    resolveAlias?: (name: string) => string | null;
    env?: NodeJS.ProcessEnv;
    /** Seam for the fs check; the default is the real one. */
    hookPresent?: (hooksDir: string) => boolean;
  },
): string[] {
  const classification = classifyGitInvocation(argv, options.resolveAlias, options.env ?? {});

  // Checked ahead of the not-a-push early return, deliberately. A shell alias
  // cannot be classified as a push or not — its expansion is arbitrary shell —
  // and it is the one form that escapes this guard entirely, because git
  // prepends its exec-path (which ships a complete `git`) to PATH for the shell
  // it spawns. So a bare `git push` inside the expansion reaches the real git
  // without passing through this wrapper or the hook.
  if (classification.shellAlias) {
    const { alias, expansion } = classification.shellAlias;
    throw new GitEgressRuntimeError(
      `paperclip-github-egress: refusing to run the shell alias \`${alias}\` (\`${expansion}\`). A \`!\` alias runs arbitrary shell, and git puts its own exec-path ahead of PATH for it, so a \`push\` inside the expansion would reach git directly and skip the check for credential-shaped material. Run the underlying commands directly instead of through the alias.`,
    );
  }

  // Checked ahead of the not-a-push early return, for the same reason the shell
  // alias above is. `classifyGitInvocation` keeps a bypass with no push attached
  // ONLY for the two reasons that exist because "is this a push?" is itself the
  // question that went unanswered — `unquotable` and `alias-depth` — and it
  // documents at length why neither may be gated on `isPush`. Letting the early
  // return below discard them defeats that one layer up, silently: the shim
  // reports the refusal and the wrapper drops it.
  //
  // Measured against git 2.47.3 with `alias.a1=a2 … alias.a5=push`: the early
  // return handed argv straight to git, which expanded the whole chain and
  // pushed `refs/heads/deep5` to the remote with no hook. The unit test on
  // `classifyGitInvocation` passed throughout — it asserts the bypass is
  // REPORTED, which it was. Only driving the wrapper end to end showed it being
  // thrown away.
  //
  // The push-carried reasons are deliberately NOT handled here; they fall
  // through to the block below so the argv-level `--no-verify` and
  // `core.hooksPath` refusals keep winning the message on a real push.
  if (
    classification.aliasBypass &&
    (classification.aliasBypass.reason === "unquotable" ||
      classification.aliasBypass.reason === "alias-depth")
  ) {
    throw aliasBypassRefusal(classification.aliasBypass);
  }

  if (!classification.isPush) return [...argv];

  if (classification.hasNoVerify) {
    throw new GitEgressRuntimeError(
      "paperclip-github-egress: --no-verify is disabled on publish, because it skips the hook that checks whether the commits carry credential-shaped material. Re-run without it.",
    );
  }

  // Injecting last already wins over this, so the refusal is not what makes the
  // guard hold — it is here so a caller who asked for a different hooks
  // directory is told their request was rejected rather than silently dropped,
  // and so the control does not rest on ordering alone.
  if (classification.hooksPathOverride) {
    throw new GitEgressRuntimeError(
      `paperclip-github-egress: refusing to publish — this invocation sets core.hooksPath itself (\`${classification.hooksPathOverride}\`), which would replace the hook that checks whether these commits carry credential-shaped material. Re-run the push without it.`,
    );
  }

  // An alias is the one case injection cannot win: git expands it AFTER the
  // command line, so a `-c core.hooksPath=` or `--no-verify` inside the
  // expansion is the last thing git sees no matter where the guard is placed.
  // Refusal is the only enforcement available here.
  if (classification.aliasBypass) {
    throw aliasBypassRefusal(classification.aliasBypass);
  }

  // Last, so the specific caller-error refusals above win the message. Placed
  // before the injection because injecting a hooks path with no hook in it is
  // indistinguishable, from the outside, from a push that was scanned.
  const hookPresent = options.hookPresent ?? prePushHookPresent;
  if (!hookPresent(options.hooksDir)) {
    throw new GitEgressRuntimeError(
      `paperclip-github-egress: refusing to publish — no executable pre-push hook at \`${path.join(options.hooksDir, "pre-push")}\`, so this push could not be checked for credential-shaped material. This is a deployment fault, not something to work around: the hook is written by the chart's agent-runtime seed. Report it rather than pushing past it.`,
    );
  }

  // Immediately before the subcommand: after the caller's global options, so
  // this is the last `core.hooksPath` git reads, and still ahead of the
  // subcommand, which is where git requires global options to sit.
  const at = classification.subcommandIndex;
  return [
    ...argv.slice(0, at),
    "-c",
    `core.hooksPath=${options.hooksDir}`,
    ...argv.slice(at),
  ];
}

export function makeGitReader(gitPath: string, cwd?: string): GitReader {
  return (args: string[]) => {
    const result = spawnSync(gitPath, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  };
}

/**
 * The part of `process.stdin` the hook reads, narrowed so a test can supply a
 * stand-in. `isTTY` is the field the refusal in {@link readStdin} turns on.
 */
export interface HookStdin {
  isTTY?: boolean;
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Read the ref-update list git pipes to the pre-push hook.
 *
 * Takes the stream so the refusal below is reachable from a test without
 * allocating a pty; production passes `process.stdin`.
 */
export function readStdin(stream: HookStdin = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    // A TTY on stdin means git did not invoke this. Git always hands the
    // pre-push hook a pipe — measured against git 2.47.3, `isTTY` is false and
    // fd 0 is a FIFO on both a real push and an "Everything up-to-date" one.
    //
    // Resolving "" here was the fail-open: it is indistinguishable from the
    // empty ref list git legitimately sends for a no-op push, so
    // `runPrePushHook` returned 0 and the caller read "scanned and clean" from
    // a run that never had input to scan. Refuse instead — the guard cannot see
    // its input, and an unread ref update is an unscanned ref update.
    //
    // Note this rejects rather than waiting for `end`: a TTY never ends, so
    // waiting would hang the push instead of refusing it.
    if (stream.isTTY) {
      reject(new Error("pre-push hook stdin is a TTY; expected the ref-update pipe git supplies"));
      return;
    }
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
    });
    stream.on("end", () => resolve(buffer));
    // Reject rather than resolving the partial buffer. A truncation that lands
    // mid-line throws in `parsePrePushInput` and refuses, but one landing
    // exactly on a newline yields a SHORTER, well-formed update list — and
    // `runPrePushHook` reads a short list as "that is all this push contains"
    // and returns 0 for the ref updates that were dropped. The rejection
    // reaches `reportRuntimeError`, which sets a non-zero exit code, so the
    // push aborts: an unread ref update is an unscanned ref update, exactly as
    // an unreadable commit is an unscanned commit.
    stream.on("error", reject);
  });
}

/**
 * The pre-push hook. Exit 0 lets the push proceed; non-zero aborts it.
 *
 * Every remote is guarded, not only github.com. The material this refuses is
 * credential-shaped wherever it lands, and scoping the check by remote URL would
 * turn `git remote add` into the bypass.
 *
 * The scan is wrapped so that ANY failure aborts the push. A guard whose error
 * path is "allow" is not a guard: a git read that fails, a buffer that
 * overflows on a large diff, or an unanticipated throw would each otherwise
 * publish the commits unscanned, and the larger the push the likelier that gets.
 */
export async function runPrePushHook(options: {
  input: string;
  runGit: GitReader;
  stderr?: (message: string) => void;
}): Promise<number> {
  const write = options.stderr ?? ((message: string) => process.stderr.write(`${message}\n`));

  let findings;
  try {
    // Inside the try: parsing the hook's stdin is part of deciding what this
    // push publishes, so a throw from it must refuse like any other unknown
    // verdict rather than escaping the guard's own error path.
    const updates = parsePrePushInput(options.input);
    // An empty update list is a PASS, and must stay one. Git runs the pre-push
    // hook with genuinely empty stdin on an "Everything up-to-date" push —
    // measured against git 2.47.3, hook invoked, zero bytes on the pipe — so
    // refusing here would fail every no-op push.
    //
    // What makes that safe is that the one way to arrive here WITHOUT git
    // having said "nothing to push" is now closed upstream: `readStdin` refuses
    // a TTY rather than resolving "", so "git sent an empty list" and "this was
    // never invoked by git" are no longer the same value.
    if (updates.length === 0) return 0;
    findings = scanPrePushUpdates(updates, options.runGit);
  } catch (error) {
    // Deliberately catching everything, not just GitEgressScanError. An
    // unexpected throw is exactly the case where the scanner's verdict is
    // unknown, which must refuse rather than pass.
    write(formatScanFailure(error));
    return 1;
  }

  if (findings.length === 0) return 0;

  write(formatRefusal(findings));
  return 1;
}

export function runGitEgressRuntime(options: {
  target: string;
  argv: string[];
  hooksDir: string;
  env?: NodeJS.ProcessEnv;
  hookPresent?: (hooksDir: string) => boolean;
}): Promise<number> {
  const env = options.env ?? process.env;

  // Resolve aliases under the same effective configuration git itself will use.
  // A bare `git config --get` reads whichever config files the WRAPPER's cwd
  // selects, which is not necessarily the set the invocation selects: `-C`,
  // `--git-dir` and `--work-tree` all change it, so `git -C /elsewhere yolo`
  // would be looked up against the wrong repository. Forwarding the caller's
  // own global options puts the lookup in the same place as the push.
  //
  // `--no-pager` goes last so it beats a caller's `-p`, which would otherwise
  // hand this read to a pager. Nothing here can run a hook: `config` is a read.
  //
  // This does NOT cover `-c alias.x=...`; a definition on the command line is
  // unreachable from a second process no matter what it is passed. That case is
  // closed in `classifyGitInvocation`, which reads such definitions straight out
  // of argv and consults them before this callback.
  const globals = gitGlobalOptions(options.argv);
  const resolveAlias = (name: string): string | null => {
    const result = spawnSync(
      options.target,
      [...globals, "--no-pager", "config", "--get", `alias.${name}`],
      { encoding: "utf8", env, timeout: 10_000 },
    );
    if (result.error || result.status !== 0) return null;
    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  };

  const argv = buildGitArgv(options.argv, {
    hooksDir: options.hooksDir,
    resolveAlias,
    env,
    hookPresent: options.hookPresent,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(options.target, argv, { stdio: "inherit" });
    let forwardedSignal = false;
    let settled = false;
    const forwardSignal = (signal: NodeJS.Signals) => {
      forwardedSignal = true;
      child.kill(signal);
    };
    process.on("SIGINT", forwardSignal);
    process.on("SIGTERM", forwardSignal);
    const cleanup = () => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitEgressRuntimeError(`unable to start git (${error.code ?? "unknown error"})`, 1));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== null) {
        resolve(code);
        return;
      }
      resolve(forwardedSignal ? 128 : signal ? 128 + (signal === "SIGINT" ? 2 : 15) : 1);
    });
  });
}

function reportRuntimeError(error: unknown): void {
  const message = error instanceof Error ? error.message : "unexpected preparation failure";
  const exitCode = error instanceof GitEgressRuntimeError ? error.exitCode : 1;
  console.error(message.startsWith("paperclip-github-egress") ? message : `paperclip-github-egress: ${message}`);
  process.exitCode = exitCode;
}

/**
 * Is this module the process entrypoint?
 *
 * Tolerates a symlinked install. `process.argv[1]` is the literal path the
 * caller named; `import.meta.url` is what Node resolved, which is the REALPATH
 * unless `--preserve-symlinks` is set. A plain string compare of the two is
 * false whenever any parent directory is a link — measured on Node 24.16: with
 * the package reached through a symlinked directory, `path.resolve(argv[1])`
 * and `fileURLToPath(import.meta.url)` differ, and `realpathSync` agrees again.
 *
 * This is used ONLY for the wrapper leg. The hook leg must not depend on it —
 * see the entry block below for why.
 */
function invokedAsEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const here = fileURLToPath(import.meta.url);
  if (path.resolve(argv1) === here) return true;
  try {
    return realpathSync(argv1) === realpathSync(here);
  } catch {
    // An unresolvable argv[1] is not this module. The hook leg does not reach
    // here, so returning false cannot open the publish boundary.
    return false;
  }
}

// Hook mode is selected by argv ALONE, deliberately, and not by
// `invokedAsEntrypoint()`.
//
// The entrypoint guard is the standard idiom, and it is copied from
// `github-cli-egress-runtime.ts` and `github-mcp-egress-runtime.ts` where it is
// safe. It is NOT safe here, and the failure direction is inverted: for `gh` and
// `github-mcp-server` a bootstrap that does not run is a command that produces
// no output, which is loud. For a pre-push hook it is a silent exit 0, and git
// reads exit 0 as "hook passed" — the one thing `prePushHookPresent` documents
// that this door cannot tolerate, reinstated one layer up.
//
// Measured end to end: with the package reached through a symlinked directory,
// a push carrying a credential-shaped literal exited 0 with no output and
// landed the commit on the remote, while the identical push through the
// unlinked path was refused and landed nothing. Causes that make the two paths
// diverge are ordinary, not exotic — pnpm's store layout, workspace hoisting,
// or a bundler emitting a re-export shim.
//
// `realpathSync` alone would not be enough: it repairs a symlink, but a
// re-export shim is a DIFFERENT FILE, so no amount of path canonicalisation
// makes the comparison true. The only form that fails closed is to take argv as
// the contract — `--pre-push-hook` is a private spelling nothing but the seeded
// hook passes — and keep path resolution out of the decision entirely.
const invokedAsPrePushHook = process.argv[2] === "--pre-push-hook";

if (invokedAsPrePushHook) {
  void readStdin()
    .then((input) =>
      runPrePushHook({ input, runGit: makeGitReader(gitBinary()) }),
    )
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(reportRuntimeError);
} else if (invokedAsEntrypoint()) {
  const target = process.argv[2];
  const argv = process.argv.slice(3);
  try {
    if (!target) throw new GitEgressRuntimeError("missing git target");
    void runGitEgressRuntime({ target, argv, hooksDir: hooksDirectory() })
      .then((exitCode) => {
        process.exitCode = exitCode;
      })
      .catch(reportRuntimeError);
  } catch (error) {
    reportRuntimeError(error);
  }
}
