/**
 * PEN-1305 Layer 1 — enforced pre-execution block for full-environment dumps.
 *
 * Background: agent heartbeats repeatedly ran unrestricted environment
 * inspection (`env` / `printenv` / `set` / `export -p` / `declare -x` /
 * `cat /proc/<pid>/environ`), dumping live secret-bearing runtime variables into
 * the run transcript. The Paperclip server ships a transcript-redaction layer
 * (defense-in-depth, catches the persisted values), but the *preventive*
 * command guard (`classifyAgentShellCommand`) was never wired into a runtime
 * hook — so agents kept running the dumps and self-reporting incidents.
 *
 * This module wires that block into the claude_k8s runtime via a Claude Code
 * `PreToolUse` hook. Hooks fire even under `--dangerously-skip-permissions`
 * (which Job pods use, since there is no human to answer permission prompts),
 * so this is the correct enforcement point for unattended runs.
 *
 * This module is the ENFORCED copy — the one a Job pod actually runs. A second
 * copy of the same classifier lives at `server/src/agent-shell-guard.ts`.
 * An earlier version of this comment claimed the two were "locked in
 * behavioural parity" by `env-guard.test.ts`; that was never true — the test
 * does not reference that file, and nothing imports it in production either.
 *
 * A later version of this comment then over-corrected, calling that file simply
 * "four bypasses behind". Also wrong: the divergence runs in BOTH directions.
 * The server copy was *ahead* on the unquoted-shell-wrapper bypass, which a
 * human closed there in `993bf304c` (2026-08-04) while this copy still had it —
 * and this copy was ahead on CR/LF separators, flag-only dumps and command
 * substitution, which that copy still lacks. Neither file is the reference
 * implementation, and a fix in one does not land in the other.
 *
 * So: check the other copy before assuming a bypass is novel here, and do not
 * describe either as authoritative. Tracked for removal-or-resync as BLO-22840.
 */

export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

/**
 * The safe-helper exception. This MUST match the *whole* command, not merely
 * contain the helper somewhere in it: the exception is evaluated before the
 * full-dump detector, so a substring match would let `paperclip-safe-env && env`
 * or `safe-env-inspect; printenv` return `allow` and defeat the entire guard.
 * Arguments are permitted, but no shell metacharacter that could chain, expand,
 * or redirect into a second command (`; & | ( ) < > $ \``) may follow.
 *
 * A newline chains commands exactly like `;`, so the separator and the argument
 * tail are `[ \t]` / non-newline rather than `\s` — otherwise
 * `paperclip-safe-env\nenv` is a *whole-command* match (JS `$` without `m` is
 * end-of-input, and `\s` spans the newline) and the dump on line 2 rides in
 * under the exception.
 */
const SAFE_ENV_INSPECTION_RE =
  /^(?:node[ \t]+)?(?:[^\s;&|()<>]*\/)?(?:safe-env-inspect(?:\.mjs)?|paperclip-safe-env)(?:[ \t]+[^;&|()<>$\x60\r\n]*)?$/;

/**
 * ---------------------------------------------------------------------------
 * Shell-aware normalizer.
 *
 * WHY THIS IS NOT A REGEX ANY MORE. Five successive rounds of review closed a
 * boundary-regex bypass (`&&`, CR/LF, flag-only dumps, command substitution,
 * unquoted wrappers) and a sixth round found three more: `env >&2`, `e''nv`
 * and `env -S '-u PATH'`. Re-measured against the real spawned pod script,
 * that round's class was wider than reported — 10 of 12 probe payloads were
 * ALLOWED while `/bin/sh` demonstrably dumped a marker variable, including
 * `e"n"v`, `\env`, `'env'`, `env>&2`, `env 2>&1` and `env -S '-0'`.
 *
 * The reason is structural, not a missing character class. A regex matches the
 * command *text*, but the shell executes the command *after* quote removal,
 * escape processing, redirection stripping and (for GNU `env -S`) argument
 * re-splitting. Any classifier that inspects the text before those
 * transformations is matching a different string than the one that runs, so
 * each new boundary character only closes the instance that was reported.
 *
 * So: lex the command the way a shell does — quote removal, escape handling,
 * operator splitting, redirection stripping — and classify the resulting
 * words. Bypasses that depend on spelling the same token differently
 * (`e''nv`, `'env'`, `\env`) collapse to the same word and are caught by
 * construction rather than by enumeration.
 *
 * The lexer is deliberately partial: it recognises the constructs that change
 * which token executes, not the whole POSIX grammar. Anything it cannot
 * resolve (a substitution body, a quoted multi-word payload) is re-analysed as
 * a nested command, which errs toward blocking — consistent with this file's
 * long-standing stance that a bare `env` inside a quoted string also matches.
 * The safe helper remains the unblocked path.
 *
 * DOCUMENTED RESIDUAL: values resolved at runtime. `X=env; $X` and
 * `cat /proc/$$/environ` are ALLOWED and cannot be closed here — the classifier
 * sees the command text, and no static pass over text can know what an
 * expansion will evaluate to. This is a different class from the spelling
 * variants above, which are closed by construction; it is not an enumerable
 * gap, so a future round should not read it as one. The mitigation for this
 * class is the fail-open-by-design guard plus server-side redaction, not more
 * lexing.
 * ---------------------------------------------------------------------------
 */

/**
 * ---------------------------------------------------------------------------
 * DECISION (BLO-22514): this guard stays FAIL-OPEN. Recorded here rather than
 * only on the issue, because the next person to read `exit 0` on a security
 * hook will reasonably wonder whether it was an oversight. It was not.
 *
 * BLO-22514 asked the question because the guard both fails open on any error
 * and demonstrably did not fire against a live `printenv "$V"` in 2026-08. Both
 * observations are accurate. The conclusion still lands on fail-open, for three
 * reasons:
 *
 *   1. The blast radius is asymmetric. This hook runs inside the agent's own
 *      runtime and is advisory: failing closed wedges EVERY agent run in the
 *      fleet on any parse error or malformed hook event, against a benefit that
 *      is bounded by point 2.
 *   2. It cannot be made complete, so "fail closed" would buy less than it
 *      looks. See the DOCUMENTED RESIDUAL above: `X=env; $X` and
 *      `cat /proc/$$/environ` resolve at runtime, and no static pass over
 *      command text can classify them. A classifier that cannot be complete is
 *      the wrong place to put a hard stop.
 *   3. Most decisively, BLO-22514 removed what this guard was standing in front
 *      of. Agent pods no longer inherit the server's control-plane secrets (see
 *      inherit-allowlist.ts), so a successful environment dump now discloses
 *      agent-scoped provider credentials the agent already holds and uses —
 *      not the JWT signing key, the database URL, or the GitHub App key. The
 *      guard's role drops from "last line before control-plane compromise" to
 *      hygiene, which argues further against paying an availability cost for it.
 *
 * The real control is the allowlist, not this hook. Treat this as
 * defense-in-depth and keep it non-load-bearing; if a future change makes an
 * environment dump consequential again, revisit BOTH this decision and the
 * reason the dump became consequential.
 * ---------------------------------------------------------------------------
 */

/** Backtick, written as an escape because the pod script below is a `String.raw` template. */
const BACKTICK = "\x60";
/** Utilities that dump the whole environment when given no operand. */
const ENV_DUMP_UTILS = ["env", "printenv"];

/** Reading a process's environ file is a dump regardless of the reader. */
const PROC_ENVIRON_RE = /\/proc\/(?:self|\d+)\/environ/;

/**
 * Shells whose `-c` argument is a *command string* rather than an operand.
 *
 * This is the one wrapper class that must be recursed rather than scanned:
 * in `sh -c env ls`, `env` is the command and `ls` is merely `$0`, so a flat
 * scan would read `ls` as `env`'s operand and allow a full dump. Non-shell
 * wrappers (`eval`, `xargs`, `nohup`, `timeout`, `su -c`, `watch`, …) need no
 * enumeration: their payload stays a normal word and the flat scan below
 * already catches it.
 */
const SHELL_BASENAMES = ["sh", "bash", "zsh", "ksh", "dash", "ash", "busybox"];

type LexedCommand = string[];

interface LexResult {
  /** Simple commands, as quote-removed word lists, split on shell operators. */
  commands: LexedCommand[];
  /** Command strings needing their own pass: substitution bodies and quoted payloads. */
  nested: string[];
  /**
   * Redirection target words, quote-removed. Kept separately from `commands`
   * because a target is NOT an operand — folding `env >/tmp/out` back into the
   * word list would give `env` an operand and allow the dump — but the shell
   * still opens the file, so the target must be classified.
   */
  redirections: string[];
}

function basename(word: string): string {
  const cut = word.lastIndexOf("/");
  return cut === -1 ? word : word.slice(cut + 1);
}

/**
 * Lex a command string the way a shell does, to the depth that affects which
 * token is executed. Performs quote removal and escape processing, splits on
 * command operators, and separates redirections (operator plus target) out of
 * the word list while still recording each target.
 */
function lexShell(input: string): LexResult {
  const commands: LexedCommand[] = [];
  const nested: string[] = [];
  const redirections: string[] = [];
  let words: string[] = [];
  let cur: string | null = null;
  let curQuoted = false;
  let i = 0;
  const n = input.length;

  const add = (s: string): void => {
    cur = (cur === null ? "" : cur) + s;
  };
  const endWord = (): void => {
    if (cur === null) return;
    // A quoted payload containing a command SEPARATOR may itself be a command
    // string (`eval "echo ok; env"`); re-analyse it rather than treating it as
    // one opaque word. Deliberately keyed on separators and not on whitespace:
    // recursing on whitespace alone would block ordinary prose arguments such
    // as `git commit -m 'fix env'`, and a shell wrapper's `-c` payload is
    // already recursed explicitly by `shellPayloadIndex` below.
    if (curQuoted && /[;&|()\r\n]/.test(cur)) nested.push(cur);
    words.push(cur);
    cur = null;
    curQuoted = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };

  /** Reads `$(...)`, a backtick pair, `${...}` or `$NAME`, recording bodies to re-analyse. */
  const readExpansion = (start: number): number => {
    if (input[start] === BACKTICK) {
      let j = start + 1;
      let body = "";
      while (j < n && input[j] !== BACKTICK) {
        if (input[j] === "\\" && j + 1 < n) {
          body += input[j + 1];
          j += 2;
          continue;
        }
        body += input[j];
        j += 1;
      }
      nested.push(body);
      if (cur === null) cur = "";
      return j + 1;
    }
    if (input[start + 1] === "(") {
      let depth = 0;
      let j = start + 1;
      let body = "";
      for (; j < n; j += 1) {
        const c = input[j];
        if (c === "(") {
          depth += 1;
          if (depth === 1) continue;
        } else if (c === ")") {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
        if (depth >= 1) body += c;
      }
      nested.push(body);
      if (cur === null) cur = "";
      return j;
    }
    if (input[start + 1] === "{") {
      let j = start + 2;
      while (j < n && input[j] !== "}") j += 1;
      if (cur === null) cur = "";
      return j + 1;
    }
    let j = start + 1;
    while (j < n && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
    if (cur === null) cur = "";
    return j === start + 1 ? start + 1 : j;
  };

  /**
   * Consumes a redirection operator and its target, as the shell does before
   * exec — but RECORDS the target, because the shell still opens that file.
   * `cat </proc/self/environ` dumps the environment without the path ever
   * reaching argv, so discarding the target outright allows it.
   */
  const readRedirection = (start: number): number => {
    let j = start;
    while (j < n && (input[j] === "<" || input[j] === ">" || input[j] === "&")) j += 1;
    while (j < n && (input[j] === " " || input[j] === "\t")) j += 1;
    // Capture the target word (quoted or bare) with quotes removed.
    let target = "";
    if (j < n && (input[j] === "'" || input[j] === '"')) {
      const q = input[j];
      j += 1;
      while (j < n && input[j] !== q) {
        target += input[j] as string;
        j += 1;
      }
      j += 1;
    } else {
      while (j < n && !/[\s;&|()<>]/.test(input[j] as string)) {
        target += input[j] as string;
        j += 1;
      }
    }
    if (target) redirections.push(target);
    return j;
  };

  while (i < n) {
    const ch = input[i] as string;

    if (ch === " " || ch === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endCommand();
      i += 1;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < n) {
        if (input[i + 1] === "\n") {
          i += 2;
          continue;
        }
        // Escape removal: `\env` is the word `env`.
        add(input[i + 1] as string);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      if (cur === null) cur = "";
      curQuoted = true;
      i += 1;
      while (i < n && input[i] !== "'") {
        add(input[i] as string);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cur === null) cur = "";
      curQuoted = true;
      i += 1;
      while (i < n && input[i] !== '"') {
        const c = input[i] as string;
        if (c === "\\" && i + 1 < n) {
          const nx = input[i + 1] as string;
          if (nx === '"' || nx === "\\" || nx === "$" || nx === BACKTICK) {
            add(nx);
            i += 2;
            continue;
          }
          add(c);
          i += 1;
          continue;
        }
        if (c === "$" || c === BACKTICK) {
          i = readExpansion(i);
          continue;
        }
        add(c);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "$" || ch === BACKTICK) {
      i = readExpansion(i);
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A bare leading file-descriptor number belongs to the redirection.
      if (cur !== null && /^\d+$/.test(cur)) {
        cur = null;
        curQuoted = false;
      } else {
        endWord();
      }
      i = readRedirection(i);
      continue;
    }
    if (ch === "&") {
      if (input[i + 1] === ">") {
        endWord();
        i = readRedirection(i);
        continue;
      }
      endCommand();
      i += input[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "|") {
      endCommand();
      i += input[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      endCommand();
      i += 1;
      continue;
    }
    add(ch);
    i += 1;
  }
  endCommand();
  return { commands, nested, redirections };
}

/**
 * True when the argument list contains a real *operand* — a command to run or
 * a variable name to print — which is what stops `env`/`printenv` dumping.
 *
 * Flags alone never stop the dump: `-0`/`--null` dump NUL-separated and
 * `-u NAME` dumps everything but one variable. GNU `env -S STRING` re-splits
 * STRING into further arguments, so its payload is expanded here rather than
 * counted as an operand — that is what makes `env -S '-u PATH'` a dump.
 */
function hasOperand(args: string[]): boolean {
  const queue = args.slice();
  let guard = 0;
  while (queue.length > 0 && guard < 256) {
    guard += 1;
    const a = queue.shift() as string;
    if (a === "--") return queue.length > 0;
    if (a === "-u" || a === "--unset") {
      queue.shift();
      continue;
    }
    if (a.indexOf("--unset=") === 0) continue;
    if (a === "-S" || a === "--split-string") {
      const payload = queue.shift();
      if (payload != null) queue.unshift(...payload.split(/[ \t]+/).filter(Boolean));
      continue;
    }
    if (a.indexOf("--split-string=") === 0) {
      queue.unshift(...a.slice("--split-string=".length).split(/[ \t]+/).filter(Boolean));
      continue;
    }
    if (a.length > 1 && a[0] === "-" && a[1] !== "-") {
      // Bundled short flags; GNU env allows `S` inside the bundle (`-vS '…'`).
      const sAt = a.indexOf("S");
      if (sAt !== -1) {
        const inline = a.slice(sAt + 1);
        if (inline) {
          queue.unshift(...inline.split(/[ \t]+/).filter(Boolean));
        } else {
          const payload = queue.shift();
          if (payload != null) queue.unshift(...payload.split(/[ \t]+/).filter(Boolean));
        }
      }
      continue;
    }
    if (a.indexOf("--") === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
    return true;
  }
  return false;
}

/**
 * True when `args` names something for `declare`/`export` to act on, which is
 * what makes them scoped rather than a dump. Any non-flag word counts,
 * assignments included: `declare -p PATH` and `export FOO=bar` print one entry.
 *
 * This replaces a whole-word flag comparison (`rest.indexOf("-x")`), which was
 * enumeration and missed most of the class. Measured against `bash -c`, with a
 * marker variable in the environment:
 *
 *   declare       447 lines, marker value present  <- was ALLOWED
 *   declare -p    460 lines, marker value present  <- was ALLOWED
 *   declare -px   421 lines, marker value present  <- was ALLOWED
 *   export        421 lines, marker value present  <- was ALLOWED
 *   declare -x    421 lines, marker value present     (caught)
 *   export -p     421 lines, marker value present     (caught)
 *
 * Keying on the operand instead of on flags closes bundled clusters (`-px`,
 * `-xp`), the bare forms, and `-p` in one rule, the same way `hasOperand`
 * handles `env`/`printenv`. `declare -f` prints function bodies and no values,
 * so blocking it is a false positive — accepted deliberately: it costs a
 * command nothing runs, where a false negative leaks the whole environment.
 */
function hasNameOperand(args: string[]): boolean {
  for (const a of args) {
    if (a === "--") continue;
    if (a.length > 0 && a[0] === "-") continue;
    return true;
  }
  return false;
}

/** Classifies one simple command (already quote-removed and redirection-stripped). */
function simpleCommandDumps(words: string[]): boolean {
  if (words.length === 0) return false;
  for (const w of words) if (PROC_ENVIRON_RE.test(w)) return true;

  for (let i = 0; i < words.length; i += 1) {
    const base = basename(words[i] as string);
    const rest = words.slice(i + 1);
    if (ENV_DUMP_UTILS.indexOf(base) !== -1) {
      if (!hasOperand(rest)) return true;
      continue;
    }
    if (base === "set") {
      // Bare `set` prints every shell variable, exported secrets included.
      if (rest.length === 0) return true;
      continue;
    }
    if (base === "export" && !hasNameOperand(rest)) return true;
    if (base === "declare" && !hasNameOperand(rest)) return true;
  }
  return false;
}

/** Index of a shell wrapper's `-c` payload word, or -1. */
function shellPayloadIndex(words: string[]): number {
  for (let i = 0; i < words.length; i += 1) {
    if (SHELL_BASENAMES.indexOf(basename(words[i] as string)) === -1) continue;
    for (let j = i + 1; j < words.length; j += 1) {
      const w = words[j] as string;
      if (/^-[a-z]*c$/.test(w)) return j + 1 < words.length ? j + 1 : -1;
      if (w[0] !== "-") break;
    }
  }
  return -1;
}

function containsDump(command: string, depth: number): boolean {
  if (depth > 4) return false;
  const { commands, nested, redirections } = lexShell(command);
  // The shell opens a redirection target even though it never enters argv, so
  // `cat </proc/self/environ` is only reachable from the target word.
  for (const target of redirections) if (PROC_ENVIRON_RE.test(target)) return true;
  for (const words of commands) {
    const payload = shellPayloadIndex(words);
    if (payload !== -1) {
      // Everything after a shell's `-c` payload is `$0`/`$1`, not an operand.
      if (containsDump(words[payload] as string, depth + 1)) return true;
      if (simpleCommandDumps(words.slice(0, payload))) return true;
      continue;
    }
    if (simpleCommandDumps(words)) return true;
  }
  for (const body of nested) {
    if (body.trim() && containsDump(body, depth + 1)) return true;
  }
  return false;
}

/**
 * Classify an agent shell command. `block` for a full-environment dump; `allow`
 * for the allowlisted names-only helper or any non-dump command.
 */
export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = command.trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  if (SAFE_ENV_INSPECTION_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  if (containsDump(normalized, 0)) return { action: "block", reason: "full_environment_dump" };
  return { action: "allow", reason: "not_environment_dump" };
}

/**
 * Standalone, zero-dependency Node script written into the agent pod and
 * invoked by the Claude Code PreToolUse hook. Reads the hook event JSON on
 * stdin; on a Bash full-environment dump it writes a value-free reason to
 * stderr and exits 2 (Claude Code blocks the tool and feeds stderr to the
 * model). Any parse/other error fails OPEN (exit 0) so the guard can never
 * wedge a run — the server-side redaction layer remains the backstop.
 *
 * Authored with regex *literals* (not `new RegExp(...)`) so the surrounding
 * `String.raw` preserves single backslashes verbatim — no double-escaping, no
 * backticks. Keep behaviourally identical to `classifyAgentShellCommand`
 * above; `env-guard.test.ts` runs the same command corpus through both.
 */
export const ENV_GUARD_SCRIPT = String.raw`#!/usr/bin/env node
// paperclip-env-guard.mjs — PEN-1305 Layer 1 PreToolUse guard. Generated by
// paperclip-adapter-claude-k8s; do not edit in the pod.
const SAFE_ENV_INSPECTION_RE =
  /^(?:node[ \t]+)?(?:[^\s;&|()<>]*\/)?(?:safe-env-inspect(?:\.mjs)?|paperclip-safe-env)(?:[ \t]+[^;&|()<>$\x60\r\n]*)?$/;
// Shell-aware normalizer. Behaviourally identical to classifyAgentShellCommand
// in env-guard.ts; env-guard.test.ts runs the SAME corpus through both, so any
// drift between the two copies fails the suite. A regex over command TEXT
// cannot be correct here: the shell executes the command after quote removal,
// escape processing, redirection stripping and GNU "env -S" re-splitting, so
// the text matched is not the token that runs. Lex first, then classify.
const BACKTICK = "\x60";
const ENV_DUMP_UTILS = ["env", "printenv"];
const PROC_ENVIRON_RE = /\/proc\/(?:self|\d+)\/environ/;
const SHELL_BASENAMES = ["sh", "bash", "zsh", "ksh", "dash", "ash", "busybox"];
function basename(word) {
  const cut = word.lastIndexOf("/");
  return cut === -1 ? word : word.slice(cut + 1);
}
function lexShell(input) {
  const commands = [];
  const nested = [];
  const redirections = [];
  let words = [];
  let cur = null;
  let curQuoted = false;
  let i = 0;
  const n = input.length;
  const add = (s) => { cur = (cur === null ? "" : cur) + s; };
  const endWord = () => {
    if (cur === null) return;
    if (curQuoted && /[;&|()\r\n]/.test(cur)) nested.push(cur);
    words.push(cur);
    cur = null;
    curQuoted = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const readExpansion = (start) => {
    if (input[start] === BACKTICK) {
      let j = start + 1;
      let body = "";
      while (j < n && input[j] !== BACKTICK) {
        if (input[j] === "\\" && j + 1 < n) { body += input[j + 1]; j += 2; continue; }
        body += input[j];
        j += 1;
      }
      nested.push(body);
      if (cur === null) cur = "";
      return j + 1;
    }
    if (input[start + 1] === "(") {
      let depth = 0;
      let j = start + 1;
      let body = "";
      for (; j < n; j += 1) {
        const c = input[j];
        if (c === "(") { depth += 1; if (depth === 1) continue; }
        else if (c === ")") { depth -= 1; if (depth === 0) { j += 1; break; } }
        if (depth >= 1) body += c;
      }
      nested.push(body);
      if (cur === null) cur = "";
      return j;
    }
    if (input[start + 1] === "{") {
      let j = start + 2;
      while (j < n && input[j] !== "}") j += 1;
      if (cur === null) cur = "";
      return j + 1;
    }
    let j = start + 1;
    while (j < n && /[A-Za-z0-9_]/.test(input[j])) j += 1;
    if (cur === null) cur = "";
    return j === start + 1 ? start + 1 : j;
  };
  const readRedirection = (start) => {
    let j = start;
    while (j < n && (input[j] === "<" || input[j] === ">" || input[j] === "&")) j += 1;
    while (j < n && (input[j] === " " || input[j] === "\t")) j += 1;
    let target = "";
    if (j < n && (input[j] === "'" || input[j] === '"')) {
      const q = input[j];
      j += 1;
      while (j < n && input[j] !== q) { target += input[j]; j += 1; }
      j += 1;
    } else {
      while (j < n && !/[\s;&|()<>]/.test(input[j])) { target += input[j]; j += 1; }
    }
    if (target) redirections.push(target);
    return j;
  };
  while (i < n) {
    const ch = input[i];
    if (ch === " " || ch === "\t") { endWord(); i += 1; continue; }
    if (ch === "\n" || ch === "\r") { endCommand(); i += 1; continue; }
    if (ch === "\\") {
      if (i + 1 < n) {
        if (input[i + 1] === "\n") { i += 2; continue; }
        add(input[i + 1]);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      if (cur === null) cur = "";
      curQuoted = true;
      i += 1;
      while (i < n && input[i] !== "'") { add(input[i]); i += 1; }
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (cur === null) cur = "";
      curQuoted = true;
      i += 1;
      while (i < n && input[i] !== '"') {
        const c = input[i];
        if (c === "\\" && i + 1 < n) {
          const nx = input[i + 1];
          if (nx === '"' || nx === "\\" || nx === "$" || nx === BACKTICK) { add(nx); i += 2; continue; }
          add(c);
          i += 1;
          continue;
        }
        if (c === "$" || c === BACKTICK) { i = readExpansion(i); continue; }
        add(c);
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "$" || ch === BACKTICK) { i = readExpansion(i); continue; }
    if (ch === "<" || ch === ">") {
      if (cur !== null && /^\d+$/.test(cur)) { cur = null; curQuoted = false; }
      else endWord();
      i = readRedirection(i);
      continue;
    }
    if (ch === "&") {
      if (input[i + 1] === ">") { endWord(); i = readRedirection(i); continue; }
      endCommand();
      i += input[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "|") { endCommand(); i += input[i + 1] === "|" ? 2 : 1; continue; }
    if (ch === ";" || ch === "(" || ch === ")") { endCommand(); i += 1; continue; }
    add(ch);
    i += 1;
  }
  endCommand();
  return { commands: commands, nested: nested, redirections: redirections };
}
function hasNameOperand(args) {
  for (const a of args) {
    if (a === "--") continue;
    if (a.length > 0 && a[0] === "-") continue;
    return true;
  }
  return false;
}
function hasOperand(args) {
  const queue = args.slice();
  let guard = 0;
  while (queue.length > 0 && guard < 256) {
    guard += 1;
    const a = queue.shift();
    if (a === "--") return queue.length > 0;
    if (a === "-u" || a === "--unset") { queue.shift(); continue; }
    if (a.indexOf("--unset=") === 0) continue;
    if (a === "-S" || a === "--split-string") {
      const payload = queue.shift();
      if (payload != null) queue.unshift(...payload.split(/[ \t]+/).filter(Boolean));
      continue;
    }
    if (a.indexOf("--split-string=") === 0) {
      queue.unshift(...a.slice("--split-string=".length).split(/[ \t]+/).filter(Boolean));
      continue;
    }
    if (a.length > 1 && a[0] === "-" && a[1] !== "-") {
      const sAt = a.indexOf("S");
      if (sAt !== -1) {
        const inline = a.slice(sAt + 1);
        if (inline) queue.unshift(...inline.split(/[ \t]+/).filter(Boolean));
        else {
          const payload = queue.shift();
          if (payload != null) queue.unshift(...payload.split(/[ \t]+/).filter(Boolean));
        }
      }
      continue;
    }
    if (a.indexOf("--") === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
    return true;
  }
  return false;
}
function simpleCommandDumps(words) {
  if (words.length === 0) return false;
  for (const w of words) if (PROC_ENVIRON_RE.test(w)) return true;
  for (let i = 0; i < words.length; i += 1) {
    const base = basename(words[i]);
    const rest = words.slice(i + 1);
    if (ENV_DUMP_UTILS.indexOf(base) !== -1) {
      if (!hasOperand(rest)) return true;
      continue;
    }
    if (base === "set") {
      if (rest.length === 0) return true;
      continue;
    }
    if (base === "export" && !hasNameOperand(rest)) return true;
    if (base === "declare" && !hasNameOperand(rest)) return true;
  }
  return false;
}
function shellPayloadIndex(words) {
  for (let i = 0; i < words.length; i += 1) {
    if (SHELL_BASENAMES.indexOf(basename(words[i])) === -1) continue;
    for (let j = i + 1; j < words.length; j += 1) {
      const w = words[j];
      if (/^-[a-z]*c$/.test(w)) return j + 1 < words.length ? j + 1 : -1;
      if (w[0] !== "-") break;
    }
  }
  return -1;
}
function containsDump(command, depth) {
  if (depth > 4) return false;
  const lexed = lexShell(command);
  for (const target of lexed.redirections) if (PROC_ENVIRON_RE.test(target)) return true;
  for (const words of lexed.commands) {
    const payload = shellPayloadIndex(words);
    if (payload !== -1) {
      if (containsDump(words[payload], depth + 1)) return true;
      if (simpleCommandDumps(words.slice(0, payload))) return true;
      continue;
    }
    if (simpleCommandDumps(words)) return true;
  }
  for (const body of lexed.nested) {
    if (body.trim() && containsDump(body, depth + 1)) return true;
  }
  return false;
}
function isFullEnvDump(command) {
  const normalized = String(command || "").trim();
  if (!normalized) return false;
  if (SAFE_ENV_INSPECTION_RE.test(normalized)) return false;
  return containsDump(normalized, 0);
}
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const evt = JSON.parse(raw || "{}");
    const tool = evt.tool_name || evt.toolName || "";
    const input = evt.tool_input || evt.toolInput || {};
    const command = input.command || input.cmd || "";
    if (/^(?:Bash|Shell)$/i.test(String(tool)) && command && isFullEnvDump(String(command))) {
      const home = process.env.HOME || "/paperclip";
      process.stderr.write(
        "Blocked by Paperclip env-guard (PEN-1305): full-environment dumps " +
          "(env/printenv/set/export -p/declare -x/cat /proc/*/environ) are disallowed " +
          "because they leak secret-bearing runtime variables into the run transcript. " +
          "To inspect environment variable NAMES safely, run: node " +
          home + "/.claude/safe-env-inspect.mjs\n",
      );
      process.exit(2);
    }
  } catch (_e) {
    // Fail open: never wedge a run on guard error; server-side redaction backstops.
  }
  process.exit(0);
});
`;

/**
 * Names-only environment inspection helper — the allowlisted alternative the
 * guard whitelists (`safe-env-inspect`). Prints variable NAMES, never values.
 */
export const SAFE_ENV_INSPECT_SCRIPT = String.raw`#!/usr/bin/env node
// safe-env-inspect.mjs — PEN-1305 allowlisted env inspection: NAMES ONLY, never values.
for (const name of Object.keys(process.env).sort()) console.log(name);
`;

/**
 * Idempotent settings-merge script (runs via `node -`). Adds a Bash-matcher
 * PreToolUse hook to the runtime's `settings.json` only if an identical command
 * entry is not already present, preserving any existing hooks (e.g. Claude
 * Code's installed Stop hook).
 */
const SETTINGS_MERGE_SCRIPT = String.raw`const fs=require("fs"),p=require("path");const dir=process.env.CLAUDE_CONFIG_DIR||(process.env.HOME||"/paperclip")+"/.claude";const f=p.join(dir,"settings.json");let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))||{}}catch(e){}if(typeof s!=="object"||s===null)s={};s.hooks=s.hooks||{};const list=Array.isArray(s.hooks.PreToolUse)?s.hooks.PreToolUse:[];const cmd="node "+p.join(dir,"paperclip-env-guard.mjs");const has=list.some(g=>g&&Array.isArray(g.hooks)&&g.hooks.some(h=>h&&h.command===cmd));if(!has)list.push({matcher:"Bash",hooks:[{type:"command",command:cmd}]});s.hooks.PreToolUse=list;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(f,JSON.stringify(s,null,2));`;

/**
 * Build a `;`-joinable shell fragment that installs the guard + safe helper and
 * merges the PreToolUse hook into `settings.json`. Scripts are base64-embedded
 * so arbitrary JS survives `sh -c` with no quoting hazard. Runs in the MAIN
 * container (which has `node`; the init container is busybox). Fails open on
 * merge error so it can never block a run from starting.
 */
export function buildEnvGuardSetupShell(): string {
  const guardB64 = Buffer.from(ENV_GUARD_SCRIPT, "utf8").toString("base64");
  const helperB64 = Buffer.from(SAFE_ENV_INSPECT_SCRIPT, "utf8").toString("base64");
  const mergeB64 = Buffer.from(SETTINGS_MERGE_SCRIPT, "utf8").toString("base64");
  return [
    `GUARD_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"`,
    `mkdir -p "\$GUARD_DIR"`,
    `printf %s '${guardB64}' | base64 -d > "\$GUARD_DIR/paperclip-env-guard.mjs"`,
    `printf %s '${helperB64}' | base64 -d > "\$GUARD_DIR/safe-env-inspect.mjs"`,
    `printf %s '${mergeB64}' | base64 -d | node - 2>/dev/null || echo "[paperclip-env-guard] settings merge skipped" >&2`,
  ].join("; ");
}
