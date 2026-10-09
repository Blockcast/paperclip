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

import { createHash } from "node:crypto";

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

/**
 * BLO-40805. Utilities that put a LATER word back into command position, either
 * by exec'ing it (`sudo env`, `timeout 5 env`, `xargs printenv`) or by
 * re-parsing it as shell source (`eval`, `su -c`). Everything NOT on this list
 * is an ordinary utility whose arguments are DATA, so a dump utility's name
 * appearing after one is prose, a pattern, or a string literal — never a
 * command.
 *
 * The previous design note here argued these "need no enumeration" because a
 * flat scan over every word catches them without one. That is true, and it is
 * also what made the guard block `echo env`, `grep -iE 'a|env'`, and writing a
 * test fixture for this guard. The enumeration is the cost of distinguishing
 * command position from argument position; the negative controls in
 * env-guard.test.ts are the gate on it. Err toward adding a wrapper: a name on
 * this list only ever makes the scan MORE conservative.
 */
const COMMAND_POSITION_WRAPPERS = [
  ...SHELL_BASENAMES,
  "eval",
  "command",
  "builtin",
  "exec",
  "nohup",
  "setsid",
  "time",
  "timeout",
  "nice",
  "ionice",
  "stdbuf",
  "unbuffer",
  "sudo",
  "doas",
  "su",
  "runuser",
  "xargs",
  "watch",
  "env",
  "chroot",
  "script",
  "flock",
  "strace",
  "ltrace",
  "parallel",
  // Remote, container and namespace executors: the later word runs somewhere
  // else, but its output still lands in this transcript (Ally I1 on PR #2332:
  // all of these were blocked before BLO-40805 narrowed the scan).
  "ssh",
  "docker",
  "podman",
  "kubectl",
  "nsenter",
  "unshare",
  "setpriv",
  "runcon",
  "pkexec",
  "setarch",
  "taskset",
  "chrt",
  "systemd-run",
  "proot",
  "capsh",
  // Interpreters whose quoted program can shell out (`awk 'BEGIN{system("env")}'`,
  // `perl -e 'system("env")'`). Listing them re-enables the quoted-payload
  // re-lex for them; their unquoted arguments stay data as before.
  "awk",
  "gawk",
  "mawk",
  "perl",
  // Deliberately NOT listed: git. `git -c x=y env` looks up a `git-env`
  // subcommand that does not exist and dumps nothing, while listing git would
  // re-block `git grep env` and `git log --grep env` -- the false positive
  // BLO-40805 exists to remove.
];

/**
 * Programs that execute what arrives on their STDIN as a script. A heredoc
 * body is data to `cat`/`tee`, but it is the PROGRAM to `bash <<'EOF'`,
 * `sh -s`, `ssh host <<'EOF'` (the remote login shell reads stdin) and
 * `make -f -`. A quoted delimiter only suppresses expansion; it does not stop
 * the consumer executing the body (Ally C1 on PR #2332).
 *
 * The language interpreters and the `at`/`crontab` schedulers belong here too
 * (Ally I1 at a36d40f5): `python3 <<'EOF'` runs the body as Python, and an
 * `at`/`crontab` body is shell that runs later. A heredoc fed to an
 * interpreter is a program, and listing them cost no false positive on
 * `python3 -m venv env` or `node env.js`, which have no heredoc. `perl` and
 * `awk -f -` read their program from stdin the same way, and `batch` is
 * `at`'s sibling (Ally I2 at 67d7b0a1); `perl -ne 'print' env.log` and
 * `batch -l` have no heredoc and are unaffected.
 */
const HEREDOC_SCRIPT_CONSUMERS = [
  ...SHELL_BASENAMES,
  "ssh",
  "make",
  "gmake",
  "python",
  "python3",
  "node",
  "ruby",
  "php",
  "perl",
  "awk",
  "gawk",
  "mawk",
  "at",
  "batch",
  "crontab",
];

/**
 * The script consumer a simple command feeds its stdin to, or null. Found when
 * its leading program (after `NAME=value` assignments) is a script consumer,
 * or when it is a command-position wrapper that goes on to launch one
 * (`sudo bash`, `timeout 5 sh -s`, `docker exec -i c sh`). `sudo tee /etc/f`
 * and `cat <<'EOF'` stay data. A later word that merely names a shell
 * (`bash script.sh <<'EOF'`) reads as executing -- the conservative side.
 */
function stdinScriptConsumer(words: string[]): string | null {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1;
  if (i >= words.length) return null;
  const lead = basename(words[i] as string);
  if (HEREDOC_SCRIPT_CONSUMERS.indexOf(lead) !== -1) return lead;
  if (COMMAND_POSITION_WRAPPERS.indexOf(lead) === -1) return null;
  for (let j = i + 1; j < words.length; j += 1) {
    const word = basename(words[j] as string);
    if (HEREDOC_SCRIPT_CONSUMERS.indexOf(word) !== -1) return word;
  }
  return null;
}

/**
 * A crontab body's command fields, one per line. Each entry's five schedule
 * fields (or one `@reboot`-style macro) precede the command, and read as an
 * ordinary first word they stop the command scan before it reaches `env` in
 * `* * * * * env`.
 */
function cronCommands(body: string): string {
  return body.replace(/^[ \t]*(?:@\S+|(?:\S+[ \t]+){5})/gm, "");
}

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
  /**
   * Bodies of heredocs whose delimiter was UNQUOTED (`<<EOF`) and whose
   * consumer treats them as data, so only the shell's interpolation runs.
   * Kept apart from `commands` because the shell never executes a heredoc
   * body's words — only its substitutions run — and apart from quoted heredocs
   * (`<<'EOF'`) fed to data consumers, which are inert and dropped entirely.
   * A body fed to a script consumer (`bash <<'EOF'`, `cat <<'EOF' | sh`) is
   * neither: it is a program, and goes to `nested` whatever its delimiter.
   */
  heredocs: string[];
}

/**
 * A versioned or distro-aliased interpreter name (`python3.11`, `python2.7`,
 * `nodejs`, `ruby3.1`, `php8.2`, `perl5.36`) and the bare name it resolves to.
 * Every table is keyed on that bare name, and an exact-string lookup let the
 * versioned binaries RHEL, Debian and most CI images ship miss all three
 * (Ally I1 at 67d7b0a1). `python3` stays distinct from `python`.
 */
const VERSIONED_INTERPRETER_RE = /^(python3|python|node|ruby|php|perl)(?:js)?[0-9]*(?:\.[0-9]+)*$/;

function basename(word: string): string {
  const cut = word.lastIndexOf("/");
  const base = cut === -1 ? word : word.slice(cut + 1);
  const m = VERSIONED_INTERPRETER_RE.exec(base);
  return m ? (m[1] as string) : base;
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
  const heredocs: string[] = [];
  const pendingHeredocs: { delimiter: string; expanded: boolean; line: string[][]; from: number }[] = [];
  let words: string[] = [];
  // The simple commands of the pipeline being lexed, each as the SAME array
  // `words` is filled into, so a heredoc can see the commands its body reaches:
  // its own and every later stage of the pipe (`cat <<'EOF' | bash`).
  let pipeline: string[][] = [words];
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
    // one opaque word.
    //
    // BLO-40805: gated on the current command actually being an evaluator.
    // Separators alone are not evidence of a command — they are ordinary bytes
    // in a regex alternation (`grep -iE 'a|env'`), a jq program, a sed script
    // or a JSON blob, and re-lexing those re-created the very false positive
    // this guard's altitude bug is about. `words` holds the command word and
    // its preceding arguments, which is exactly the context needed to tell
    // `eval '…; env'` from `grep '…|env'`.
    if (
      curQuoted
      && /[;&|()\r\n]/.test(cur)
      && words.some((w) => COMMAND_POSITION_WRAPPERS.indexOf(basename(w)) !== -1)
    ) {
      nested.push(cur);
    }
    words.push(cur);
    cur = null;
    curQuoted = false;
  };
  const endCommand = (pipe = false): void => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
    if (pipe) pipeline.push(words);
    else pipeline = [words];
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
    let operator = "";
    while (j < n && (input[j] === "<" || input[j] === ">" || input[j] === "&")) {
      operator += input[j] as string;
      j += 1;
    }
    // BLO-40805: `<<DELIM` / `<<-DELIM` introduce a heredoc. The delimiter is
    // not a file the shell opens, and the BODY is not argv — so neither the
    // target scan nor the command scan applies to it. Record the delimiter and
    // whether any part of it was quoted; the body is consumed at the newline.
    if (operator.indexOf("<<") === 0 && operator.indexOf("<<<") !== 0) {
      if (input[j] === "-") j += 1;
      while (j < n && (input[j] === " " || input[j] === "\t")) j += 1;
      let delimiter = "";
      let expanded = true;
      while (j < n && !/[\s;&|()<>]/.test(input[j] as string)) {
        const c = input[j] as string;
        if (c === "'" || c === '"') {
          expanded = false;
          j += 1;
          while (j < n && input[j] !== c) {
            delimiter += input[j] as string;
            j += 1;
          }
          j += 1;
          continue;
        }
        if (c === "\\") {
          expanded = false;
          j += 1;
          continue;
        }
        delimiter += c;
        j += 1;
      }
      // `pipeline` keeps growing while this command line's pipe continues, so
      // the slice from the owning command on is every stage the body reaches.
      if (delimiter) pendingHeredocs.push({ delimiter, expanded, line: pipeline, from: pipeline.length - 1 });
      return j;
    }
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

  /**
   * Consumes every pending heredoc body, starting just after the newline that
   * ended the command line. A body that reaches a script consumer is a program
   * and is scanned as commands, whatever its delimiter. Otherwise it is data:
   * a quoted delimiter drops it, an unquoted one keeps it for
   * substitution-only analysis.
   */
  const consumeHeredocBodies = (start: number): number => {
    let j = start;
    while (pendingHeredocs.length) {
      const pending = pendingHeredocs.shift() as { delimiter: string; expanded: boolean; line: string[][]; from: number };
      let body = "";
      while (j < n) {
        let eol = input.indexOf("\n", j);
        if (eol === -1) eol = n;
        const line = input.slice(j, eol);
        j = eol < n ? eol + 1 : n;
        // `<<-` strips leading tabs from the terminator, so compare trimmed.
        if (line.trim() === pending.delimiter) break;
        body += `${line}\n`;
      }
      const consumer = pending.line.slice(pending.from).map(stdinScriptConsumer).find((c) => c !== null);
      if (body && consumer) nested.push(consumer === "crontab" ? cronCommands(body) : body);
      else if (pending.expanded && body) heredocs.push(body);
    }
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
      if (ch === "\n" && pendingHeredocs.length) i = consumeHeredocBodies(i);
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
      const orOperator = input[i + 1] === "|";
      endCommand(!orOperator);
      // `|&` pipes stderr too; it is still a pipe, so the next stage is reached.
      i += orOperator || input[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      endCommand();
      i += 1;
      continue;
    }
    // A `#` starting a word comments out the rest of the line. Lexing it as a
    // word instead let an apostrophe in a comment (`# it's`) open a quote that
    // swallowed the commands after it, in a heredoc body fed to `bash` or
    // `python3` as much as on the command line.
    if (ch === "#" && cur === null) {
      while (i < n && input[i] !== "\n" && input[i] !== "\r") i += 1;
      continue;
    }
    add(ch);
    i += 1;
  }
  endCommand();
  return { commands, nested, redirections, heredocs };
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

/**
 * Classifies one simple command (already quote-removed and redirection-stripped).
 *
 * BLO-40805: the scan stops at the first ORDINARY command word. Before that
 * word every token is still a candidate command — assignments, flags and
 * pass-through wrappers all keep a later word in command position — but after
 * it, every token is an argument, i.e. data. `echo env`, `grep -iE 'a|env'` and
 * a source file whose literals happen to be dump-shaped are not dumps, and
 * blocking them taught agents to route around the guard.
 *
 * Once a wrapper is seen the scan runs to the end of the word list, because a
 * wrapper's own operands (`timeout 5 env`) are not the command either and
 * enumerating each wrapper's arity would be its own source of holes.
 */
function simpleCommandDumps(words: string[]): boolean {
  if (words.length === 0) return false;
  for (const w of words) if (PROC_ENVIRON_RE.test(w)) return true;

  let sawWrapper = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as string;
    const base = basename(word);
    const rest = words.slice(i + 1);
    if (ENV_DUMP_UTILS.indexOf(base) !== -1) {
      if (!hasOperand(rest)) return true;
      // An operand means this is `env FOO=bar cmd` — a launcher, so whatever
      // it launches is still in command position.
      sawWrapper = true;
      continue;
    }
    if (base === "set") {
      // Bare `set` prints every shell variable, exported secrets included.
      if (rest.length === 0) return true;
      continue;
    }
    if (base === "export") {
      if (!hasNameOperand(rest)) return true;
      continue;
    }
    if (base === "declare") {
      if (!hasNameOperand(rest)) return true;
      continue;
    }
    if (COMMAND_POSITION_WRAPPERS.indexOf(base) !== -1) {
      sawWrapper = true;
      continue;
    }
    if (word.length > 0 && word[0] === "-") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (!sawWrapper) return false;
  }
  return false;
}

/**
 * Programs whose flag argument is itself a program, keyed by basename, with the
 * flag that introduces it: a shell's `-c`, and the language interpreters'
 * inline-program flags (`python3 -c`, `node -e`, `ruby -e`, `php -r`). Only the
 * payload word is scanned, which is why the interpreters live here and not in
 * COMMAND_POSITION_WRAPPERS: listing them there would scan every argument and
 * re-block `python3 -m venv env` (Ally I1 at a36d40f5, measured).
 */
const INLINE_PROGRAM_FLAGS = new Map<string, RegExp>([
  ...SHELL_BASENAMES.map((name): [string, RegExp] => [name, /^-[a-z]*c$/]),
  ["python", /^-[A-Za-z]*c$/],
  ["python3", /^-[A-Za-z]*c$/],
  ["node", /^(?:-[a-z]*[ep]|--eval|--print)$/],
  ["ruby", /^-[A-Za-z]*e$/],
  ["php", /^-r$/],
]);

/**
 * The interpreters' flags that take their value as the NEXT word
 * (`python3 -W ignore -c …`, `node -r dotenv/config -e …`). That value is a
 * bare word but not a script, so the flag scan steps over it as a pair instead
 * of stopping there (Ally I3 at 67d7b0a1). Listing a flag that takes no value
 * only scans further, i.e. fails toward blocking.
 */
const VALUE_TAKING_FLAGS = new Map<string, RegExp>([
  ["python", /^-[A-Za-z]*[WX]$/],
  ["python3", /^-[A-Za-z]*[WX]$/],
  ["node", /^(?:-[rC]|--require|--import|--loader|--experimental-loader|--conditions|--env-file|--input-type)$/],
  ["ruby", /^(?:-[A-Za-z]*[ICrE]|--encoding)$/],
  ["php", /^-[cdz]$/],
]);

/** Index of an inline program's payload word (`sh -c PAYLOAD`, `node -e PAYLOAD`), or -1. */
function inlineProgramIndex(words: string[]): number {
  for (let i = 0; i < words.length; i += 1) {
    const name = basename(words[i] as string);
    const flag = INLINE_PROGRAM_FLAGS.get(name);
    if (!flag) continue;
    const valueFlag = VALUE_TAKING_FLAGS.get(name);
    for (let j = i + 1; j < words.length; j += 1) {
      const w = words[j] as string;
      if (flag.test(w)) return j + 1 < words.length ? j + 1 : -1;
      if (w[0] !== "-") break;
      if (valueFlag && valueFlag.test(w)) j += 1;
    }
  }
  return -1;
}

function containsDump(command: string, depth: number): boolean {
  if (depth > 4) return false;
  const { commands, nested, redirections, heredocs } = lexShell(command);
  // The shell opens a redirection target even though it never enters argv, so
  // `cat </proc/self/environ` is only reachable from the target word.
  for (const target of redirections) if (PROC_ENVIRON_RE.test(target)) return true;
  for (const words of commands) {
    const payload = inlineProgramIndex(words);
    if (payload !== -1) {
      // Everything after an inline program is `$0`/`$1`/`sys.argv`, not an operand.
      if (containsDump(words[payload] as string, depth + 1)) return true;
      if (simpleCommandDumps(words.slice(0, payload))) return true;
      continue;
    }
    if (simpleCommandDumps(words)) return true;
  }
  for (const body of nested) {
    if (body.trim() && containsDump(body, depth + 1)) return true;
  }
  // An unquoted heredoc body is interpolated, not executed: its words never
  // reach argv, so only its command substitutions can run anything.
  for (const body of heredocs) {
    for (const inner of lexShell(body).nested) {
      if (inner.trim() && containsDump(inner, depth + 1)) return true;
    }
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
import { fileURLToPath } from "node:url";
// BLO-29526. Derive the remediation path from THIS file's own location, never
// from $HOME: installOnce() writes the guard and the helper into the same
// GUARD_DIR, so a sibling lookup cannot drift. $HOME could, and did — GUARD_DIR
// falls back to $HOME/.claude only when CLAUDE_CONFIG_DIR is unset, and the pod
// sets CLAUDE_CONFIG_DIR to a session dir outside $HOME, so the suggested
// command was always MODULE_NOT_FOUND. Agents pipe that command into a filter,
// so the error vanished into a discarded stderr and the empty stdout read as
// "no variable matches" — a confident wrong negative, not a visible failure.
// Derived inside the stdin handler, not here, so any throw lands in that
// handler's fail-open catch instead of exiting before the guard ever runs.
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
// BLO-40805: utilities that put a LATER word back into command position.
// Everything not listed is an ordinary utility whose arguments are DATA.
const COMMAND_POSITION_WRAPPERS = SHELL_BASENAMES.concat([
  "eval", "command", "builtin", "exec", "nohup", "setsid", "time", "timeout",
  "nice", "ionice", "stdbuf", "unbuffer", "sudo", "doas", "su", "runuser",
  "xargs", "watch", "env", "chroot", "script", "flock", "strace", "ltrace",
  "parallel",
  // Remote/container/namespace executors, and interpreters whose quoted
  // program can shell out. git is deliberately absent (see env-guard.ts).
  "ssh", "docker", "podman", "kubectl", "nsenter", "unshare", "setpriv",
  "runcon", "pkexec", "setarch", "taskset", "chrt", "systemd-run", "proot",
  "capsh", "awk", "gawk", "mawk", "perl",
]);
// Programs that execute their STDIN as a script: a heredoc body fed to one is
// a program, not data, whatever its delimiter's quoting. Includes the language
// interpreters (perl and awk -f - included) and the at/batch/crontab
// schedulers, whose bodies are shell.
const HEREDOC_SCRIPT_CONSUMERS = SHELL_BASENAMES.concat([
  "ssh", "make", "gmake", "python", "python3", "node", "ruby", "php",
  "perl", "awk", "gawk", "mawk", "at", "batch", "crontab",
]);
// The script consumer a simple command feeds its stdin to, or null.
function stdinScriptConsumer(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  if (i >= words.length) return null;
  const lead = basename(words[i]);
  if (HEREDOC_SCRIPT_CONSUMERS.indexOf(lead) !== -1) return lead;
  if (COMMAND_POSITION_WRAPPERS.indexOf(lead) === -1) return null;
  for (let j = i + 1; j < words.length; j += 1) {
    const word = basename(words[j]);
    if (HEREDOC_SCRIPT_CONSUMERS.indexOf(word) !== -1) return word;
  }
  return null;
}
// A crontab body's command fields: the five schedule fields (or one @reboot
// style macro) before each command would otherwise stop the command scan.
function cronCommands(body) {
  return body.replace(/^[ \t]*(?:@\S+|(?:\S+[ \t]+){5})/gm, "");
}
// A versioned or aliased interpreter (python3.11, nodejs, ruby3.1, php8.2,
// perl5.36) resolves to the bare name every table is keyed on.
const VERSIONED_INTERPRETER_RE = /^(python3|python|node|ruby|php|perl)(?:js)?[0-9]*(?:\.[0-9]+)*$/;
function basename(word) {
  const cut = word.lastIndexOf("/");
  const base = cut === -1 ? word : word.slice(cut + 1);
  const m = VERSIONED_INTERPRETER_RE.exec(base);
  return m ? m[1] : base;
}
function lexShell(input) {
  const commands = [];
  const nested = [];
  const redirections = [];
  const heredocs = [];
  const pendingHeredocs = [];
  let words = [];
  // Stages of the current pipeline, as the same arrays words fills into.
  let pipeline = [words];
  let cur = null;
  let curQuoted = false;
  let i = 0;
  const n = input.length;
  const add = (s) => { cur = (cur === null ? "" : cur) + s; };
  const endWord = () => {
    if (cur === null) return;
    // BLO-40805: a quoted word is a command string only when something
    // re-parses it (eval, su -c). Separators alone are ordinary bytes in a
    // regex alternation, a jq program or a JSON blob.
    if (
      curQuoted
      && /[;&|()\r\n]/.test(cur)
      && words.some((w) => COMMAND_POSITION_WRAPPERS.indexOf(basename(w)) !== -1)
    ) nested.push(cur);
    words.push(cur);
    cur = null;
    curQuoted = false;
  };
  const endCommand = (pipe) => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
    if (pipe) pipeline.push(words);
    else pipeline = [words];
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
    let operator = "";
    while (j < n && (input[j] === "<" || input[j] === ">" || input[j] === "&")) { operator += input[j]; j += 1; }
    // BLO-40805: a heredoc delimiter is not a file and its body is not argv.
    if (operator.indexOf("<<") === 0 && operator.indexOf("<<<") !== 0) {
      if (input[j] === "-") j += 1;
      while (j < n && (input[j] === " " || input[j] === "\t")) j += 1;
      let delimiter = "";
      let expanded = true;
      while (j < n && !/[\s;&|()<>]/.test(input[j])) {
        const c = input[j];
        if (c === "'" || c === '"') {
          expanded = false;
          j += 1;
          while (j < n && input[j] !== c) { delimiter += input[j]; j += 1; }
          j += 1;
          continue;
        }
        if (c === "\\") { expanded = false; j += 1; continue; }
        delimiter += c;
        j += 1;
      }
      if (delimiter) pendingHeredocs.push({ delimiter: delimiter, expanded: expanded, line: pipeline, from: pipeline.length - 1 });
      return j;
    }
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
  const consumeHeredocBodies = (start) => {
    let j = start;
    while (pendingHeredocs.length) {
      const pending = pendingHeredocs.shift();
      let body = "";
      while (j < n) {
        let eol = input.indexOf("\n", j);
        if (eol === -1) eol = n;
        const line = input.slice(j, eol);
        j = eol < n ? eol + 1 : n;
        if (line.trim() === pending.delimiter) break;
        body += line + "\n";
      }
      const consumer = pending.line.slice(pending.from).map(stdinScriptConsumer).find((c) => c !== null);
      if (body && consumer) nested.push(consumer === "crontab" ? cronCommands(body) : body);
      else if (pending.expanded && body) heredocs.push(body);
    }
    return j;
  };
  while (i < n) {
    const ch = input[i];
    if (ch === " " || ch === "\t") { endWord(); i += 1; continue; }
    if (ch === "\n" || ch === "\r") {
      endCommand();
      i += 1;
      if (ch === "\n" && pendingHeredocs.length) i = consumeHeredocBodies(i);
      continue;
    }
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
    // A pipe written with a trailing ampersand (stderr too) still reaches the next stage.
    if (ch === "|") { const orOp = input[i + 1] === "|"; endCommand(!orOp); i += orOp || input[i + 1] === "&" ? 2 : 1; continue; }
    if (ch === ";" || ch === "(" || ch === ")") { endCommand(); i += 1; continue; }
    // A word-initial # comments out the rest of the line, so an apostrophe in it
    // cannot open a quote that hides the commands after it.
    if (ch === "#" && cur === null) {
      while (i < n && input[i] !== "\n" && input[i] !== "\r") i += 1;
      continue;
    }
    add(ch);
    i += 1;
  }
  endCommand();
  return { commands: commands, nested: nested, redirections: redirections, heredocs: heredocs };
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
  // BLO-40805: stop at the first ORDINARY command word — after it every token
  // is an argument, i.e. data. Once a wrapper is seen, scan to the end.
  let sawWrapper = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const base = basename(word);
    const rest = words.slice(i + 1);
    if (ENV_DUMP_UTILS.indexOf(base) !== -1) {
      if (!hasOperand(rest)) return true;
      sawWrapper = true;
      continue;
    }
    if (base === "set") {
      if (rest.length === 0) return true;
      continue;
    }
    if (base === "export") {
      if (!hasNameOperand(rest)) return true;
      continue;
    }
    if (base === "declare") {
      if (!hasNameOperand(rest)) return true;
      continue;
    }
    if (COMMAND_POSITION_WRAPPERS.indexOf(base) !== -1) { sawWrapper = true; continue; }
    if (word.length > 0 && word[0] === "-") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (!sawWrapper) return false;
  }
  return false;
}
// Programs whose flag argument is itself a program: a shell's -c and the
// interpreters' inline-program flags. Only the payload word is scanned, so
// python3 -m venv env stays allowed.
const INLINE_PROGRAM_FLAGS = new Map(
  SHELL_BASENAMES.map((name) => [name, /^-[a-z]*c$/]).concat([
    ["python", /^-[A-Za-z]*c$/],
    ["python3", /^-[A-Za-z]*c$/],
    ["node", /^(?:-[a-z]*[ep]|--eval|--print)$/],
    ["ruby", /^-[A-Za-z]*e$/],
    ["php", /^-r$/],
  ]),
);
// Interpreter flags whose value is the NEXT word (python3 -W ignore -c ...):
// stepped over as a pair, since the value is not a script.
const VALUE_TAKING_FLAGS = new Map([
  ["python", /^-[A-Za-z]*[WX]$/],
  ["python3", /^-[A-Za-z]*[WX]$/],
  ["node", /^(?:-[rC]|--require|--import|--loader|--experimental-loader|--conditions|--env-file|--input-type)$/],
  ["ruby", /^(?:-[A-Za-z]*[ICrE]|--encoding)$/],
  ["php", /^-[cdz]$/],
]);
function inlineProgramIndex(words) {
  for (let i = 0; i < words.length; i += 1) {
    const name = basename(words[i]);
    const flag = INLINE_PROGRAM_FLAGS.get(name);
    if (!flag) continue;
    const valueFlag = VALUE_TAKING_FLAGS.get(name);
    for (let j = i + 1; j < words.length; j += 1) {
      const w = words[j];
      if (flag.test(w)) return j + 1 < words.length ? j + 1 : -1;
      if (w[0] !== "-") break;
      if (valueFlag && valueFlag.test(w)) j += 1;
    }
  }
  return -1;
}
function containsDump(command, depth) {
  if (depth > 4) return false;
  const lexed = lexShell(command);
  for (const target of lexed.redirections) if (PROC_ENVIRON_RE.test(target)) return true;
  for (const words of lexed.commands) {
    const payload = inlineProgramIndex(words);
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
  // An unquoted heredoc body is interpolated, not executed: only substitutions run.
  for (const body of lexed.heredocs) {
    for (const inner of lexShell(body).nested) {
      if (inner.trim() && containsDump(inner, depth + 1)) return true;
    }
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
      const helperPath = fileURLToPath(new URL("safe-env-inspect.mjs", import.meta.url));
      // Single-quoted: the suggestion is copy-pasted into a shell, so a path
      // containing a space (or $, backtick, ;) must survive re-parsing intact.
      const helperArg = "'" + helperPath.replace(/'/g, "'\\''") + "'";
      process.stderr.write(
        "Blocked by Paperclip env-guard (PEN-1305): full-environment dumps " +
          "(env/printenv/set/export -p/declare -x/cat /proc/*/environ) are disallowed " +
          "because they leak secret-bearing runtime variables into the run transcript. " +
          "To inspect environment variable NAMES safely, run: node " +
          helperArg + "\n",
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
const SETTINGS_MERGE_SCRIPT = String.raw`const fs=require("fs"),p=require("path");
const dir=process.env.CLAUDE_CONFIG_DIR||(process.env.HOME||"/paperclip")+"/.claude";
const f=p.join(dir,"settings.json");
let s={};try{s=JSON.parse(fs.readFileSync(f,"utf8"))||{}}catch(e){}
if(typeof s!=="object"||s===null)s={};
s.hooks=s.hooks||{};
const guard=process.env.PAPERCLIP_GUARD_FILE||p.join(dir,"paperclip-env-guard.mjs");
// POSIX single-quote: a CLAUDE_CONFIG_DIR containing a space must reach the
// shell as ONE argument. GUARD_RE below must stay in lockstep — it is anchored
// at $ and its class excludes ', so quoting alone would stop it matching and
// every hash rotation would APPEND a guard hook instead of replacing the old
// one. The optional trailing quote also prunes pre-quoting entries on rollout.
const cmd="node '"+guard.replace(/'/g,"'\\''")+"'";
const GUARD_RE=/paperclip-env-guard[^\s"']*\.mjs'?$/;
const list=(Array.isArray(s.hooks.PreToolUse)?s.hooks.PreToolUse:[])
  .map(function(g){
    if(!g||!Array.isArray(g.hooks))return g;
    const hooks=g.hooks.filter(function(h){
      return !(h&&typeof h.command==="string"&&h.command!==cmd&&GUARD_RE.test(h.command));
    });
    return Object.assign({},g,{hooks:hooks});
  })
  .filter(function(g){return !g||!Array.isArray(g.hooks)||g.hooks.length>0;});
const has=list.some(function(g){return g&&Array.isArray(g.hooks)&&g.hooks.some(function(h){return h&&h.command===cmd;});});
if(!has)list.push({matcher:"Bash",hooks:[{type:"command",command:cmd}]});
s.hooks.PreToolUse=list;
fs.mkdirSync(dir,{recursive:true});
const t=f+"."+process.pid+".tmp";
fs.writeFileSync(t,JSON.stringify(s,null,2));
fs.renameSync(t,f);
`;

/**
 * Build a `;`-joinable shell fragment that installs the guard + safe helper and
 * merges the PreToolUse hook into `settings.json`. Scripts are base64-embedded
 * so arbitrary JS survives `sh -c` with no quoting hazard. Runs in the MAIN
 * container (which has `node`; the init container is busybox). Fails open on
 * merge error so it can never block a run from starting.
 */
/**
 * Short content digest backing the content-addressed on-disk guard filename.
 */
function scriptDigest(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex").slice(0, 12);
}

/**
 * Shell fragment that materialises `name` from `b64` exactly once.
 *
 * `$GUARD_DIR` lives under the agent HOME, which is a ReadWriteMany CephFS
 * volume mounted by EVERY agent pod in the fleet. A plain `> file` redirect is
 * O_TRUNC, so every pod issued setattr(size=0) against the SAME inode. When one
 * such truncate wedged in the MDS (truncate_pending stuck with nothing driving
 * it), every later truncate queued behind it forever, open() on the file blocked
 * in D-state, and the PreToolUse hook hung for the whole fleet. Neither an MDS
 * failover nor a scrub clears that state, and the poisoned dentry cannot even be
 * renamed over, because unlinking the target needs the locks the stuck truncate
 * holds.
 *
 * So: never truncate a shared file. Write a pod-unique temp and rename() it into
 * place, and only when the target is absent — `test -f` stats the dentry, it
 * never opens it. Each inode is written exactly once and truncated never.
 */
function installOnce(name: string, b64: string): string {
  const target = `\$GUARD_DIR/${name}`;
  const tmp = `\$GUARD_DIR/.${name}.\$\$.tmp`;
  return (
    `[ -f "${target}" ] || ` +
    `{ printf %s '${b64}' | base64 -d > "${tmp}" && mv -f "${tmp}" "${target}"; }`
  );
}

/**
 * Build a `;`-joinable shell fragment that installs the guard + safe helper and
 * merges the PreToolUse hook into `settings.json`. Scripts are base64-embedded
 * so arbitrary JS survives `sh -c` with no quoting hazard. Runs in the MAIN
 * container (which has `node`; the init container is busybox). Fails open on
 * merge error so it can never block a run from starting.
 *
 * The guard filename is content-addressed so a guard change lands as a NEW file
 * rather than an in-place rewrite of the shared one, and so a previously
 * poisoned inode is routed around instead of waited on.
 */
export function buildEnvGuardSetupShell(): string {
  const guardB64 = Buffer.from(ENV_GUARD_SCRIPT, "utf8").toString("base64");
  const helperB64 = Buffer.from(SAFE_ENV_INSPECT_SCRIPT, "utf8").toString("base64");
  const mergeB64 = Buffer.from(SETTINGS_MERGE_SCRIPT, "utf8").toString("base64");
  const guardName = `paperclip-env-guard.${scriptDigest(ENV_GUARD_SCRIPT)}.mjs`;
  return [
    `GUARD_DIR="\${CLAUDE_CONFIG_DIR:-\$HOME/.claude}"`,
    `mkdir -p "\$GUARD_DIR"`,
    installOnce(guardName, guardB64),
    // The helper keeps a stable name: ENV_GUARD_SCRIPT names it literally in the
    // block message. It is install-once too, so it is never truncated either.
    installOnce("safe-env-inspect.mjs", helperB64),
    `PAPERCLIP_GUARD_FILE="\$GUARD_DIR/${guardName}"`,
    `export PAPERCLIP_GUARD_FILE`,
    `printf %s '${mergeB64}' | base64 -d | node - 2>/dev/null || echo "[paperclip-env-guard] settings merge skipped" >&2`,
  ].join("; ");
}

