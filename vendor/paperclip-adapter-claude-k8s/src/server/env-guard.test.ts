import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ENV_GUARD_SCRIPT,
  GUARD_HOOK_MATCHER,
  SAFE_ENV_INSPECT_SCRIPT,
  buildEnvGuardSetupShell,
  classifyAgentShellCommand,
} from "./env-guard.js";

// BLO-48145: most cases here spawn real node processes (some ten in a row), so
// their wall time scales with runner load, not with the code under test. Idle,
// the slowest case takes ~1.7 s; on an oversubscribed CI runner one spawn alone
// has taken >5 s, which tripped vitest's 5 s default and ejected unrelated PRs
// from the merge queue. 30 s still fails a genuine hang: every network call the
// guard makes is itself capped at 10 s (AbortSignal.timeout in env-guard.ts).
vi.setConfig({ testTimeout: 30_000 });

const blocked = [
  "env",
  "printenv",
  "set",
  "export -p",
  "declare -x",
  "cat /proc/self/environ",
  "cat /proc/1/environ",
  "/usr/bin/env",
  "command env",
  "env; ls -la",
  "ls && printenv",
  'sh -lc "env"',
  "bash -c 'printenv'",
  // Compound-command bypass: the safe-helper exception is evaluated before
  // the full-dump detector, so a helper appearing anywhere in the command
  // used to return `allow` and let the trailing dump through.
  "paperclip-safe-env && env",
  "safe-env-inspect; printenv",
  "./scripts/safe-env-inspect.mjs && cat /proc/self/environ",
  "node ~/.claude/safe-env-inspect.mjs | env",
  "env && paperclip-safe-env",
  'sh -lc "paperclip-safe-env && env"',
  // Newline is a command separator too. Anchoring the helper exception to the
  // whole command is not enough on its own: JS `$` without `m` is
  // end-of-input, so a `\s`-permissive argument tail made
  // `paperclip-safe-env\nenv` a whole-command match, and the dump detector
  // did not treat `\n` as a boundary either — so even `echo ok\nenv` fell
  // through as `not_environment_dump`.
  "paperclip-safe-env\nenv",
  "paperclip-safe-env\nprintenv",
  "safe-env-inspect.mjs\nenv",
  "node ~/.claude/safe-env-inspect.mjs\ncat /proc/self/environ",
  "echo ok\nenv",
  "echo ok\nprintenv",
  "echo ok\nset",
  "echo ok\nexport -p",
  "echo ok\ndeclare -x",
  "env\nls -la",
  "echo ok\r\nenv",
  'sh -lc "echo ok\nenv"',
  // Flag-only forms still dump the whole environment. Requiring a boundary
  // immediately after the utility name let every one of these through:
  // `-0`/`--null` dump NUL-separated, `-u NAME` dumps all but one variable.
  "env -0",
  "printenv -0",
  "env --null",
  "printenv --null",
  "env -u PATH",
  "env --unset PATH",
  "command env -0",
  "/usr/bin/env -0",
  "ls && env -0",
  "echo ok\nprintenv -0",
  // Command substitution is a command boundary too — the dump runs and its
  // output lands in the transcript just the same.
  'echo "$(env)"',
  "echo `env`",
  "X=$(printenv)",
  "(env)",
  "$(set)",
  "echo $(env -0 | head)",
  "`printenv`",
  "echo $(cat /proc/self/environ)",
  'sh -lc "echo $(env)"',
  // UNQUOTED command wrappers. `SHELL_WRAPPER_RE` only unwraps a *quoted* `-c`
  // payload, and a space was not a command boundary — so every form below
  // reached the detector with the dump sitting after a space, matched nothing,
  // and was ALLOWED. Measured against the real spawned pod script before the
  // fix: 9 of 9 allowed. Fixed by treating whitespace as a possible command
  // *start* (leading side only), which closes the whole wrapper class at once
  // rather than enumerating wrapper utilities.
  "sh -c env",
  "bash -c env",
  "/bin/sh -c env",
  "zsh -c env",
  "sh -lc env",
  "sh -c printenv",
  "bash -c set",
  "eval env",
  "eval printenv",
  // Wrappers that are not shells at all — the reason this is a character-class
  // rule and not a list of shell binaries.
  "xargs env",
  "nohup env",
  "timeout 5 env",
  "nice env",
  "setsid printenv",
  "su -c env",
  "watch env",
  // Round 6 — LEXICAL transformations. A regex matches the command text, but the
  // shell executes it after quote removal, escape processing, redirection
  // stripping and GNU `env -S` re-splitting, so the matched string is not the
  // token that runs. Every entry below was measured ALLOWED by the real spawned
  // pod script while `/bin/sh` emitted a marker variable from the environment.
  // Three were reported; the rest were found by probing the same class.
  "env >&2", // redirection is stripped before exec, leaving a bare `env`
  "env>&2", // ...with no space, so `env` never even ends at whitespace
  "env 2>&1", // fd-prefixed form: `2` belongs to the redirection, not to argv
  "printenv >/tmp/captured", // a file the agent can read back is still a leak
  "e''nv", // quote removal rejoins the word
  'e"n"v',
  "'env'",
  "\\env", // escape removal
  "env -S '-u PATH'", // GNU -S re-splits its payload into further flags
  "env -S '-0'",
  "env --split-string='-u PATH'",
  // Wrapper + lexical transformation combined.
  "sh -c 'e''nv'",
  "eval env >&2",
  // Round 7 — two bypasses the lexer rewrite itself opened or left open.
  // Redirection: the target word never enters argv, so stripping it outright
  // hid the path from the `/proc/*/environ` scan even though the shell still
  // opens the file. `cat /proc/self/environ` (above) blocked throughout and
  // read as coverage of this class without being it.
  "cat </proc/self/environ",
  "cat < /proc/1/environ",
  "cat <'/proc/self/environ'", // quoted target, same open
  // Bundled short-flag clusters: whole-word `-x` comparison missed `-px`,
  // which prints every exported variable WITH its value. Measured against
  // `bash -c` with a marker variable set, these all emit the marker's VALUE
  // and all classified as allow before the operand rule replaced the flag
  // comparison: `declare` (447 lines), `declare -p` (460), `declare -px`
  // (421), `export` (421). Only `declare -x` / `export -p` were caught.
  "declare -px",
  "declare -xp",
  "declare -p",
  "declare",
  "export",
  // BLO-40805 negative controls. The data-position fix must not reach an
  // UNQUOTED heredoc: the shell interpolates that body, so its substitutions
  // really do run and their output really does land in the transcript.
  "cat > /tmp/f <<EOF\n$(printenv)\nEOF",
  "cat > /tmp/f <<EOF\n`env`\nEOF",
  "cat <<EOF\nx=$(env -0)\nEOF",
  // ...nor a wrapper's payload, whichever side of the quote it sits on.
  "echo $(printenv >&2)",
  "eval 'echo ok; env'",
  "sudo env",
  "xargs -n1 printenv",
  "timeout 5 printenv",
  "su -c 'ls; env'",
  // PR #2332 review (Ally C1): a heredoc body is DATA only to a data consumer.
  // Fed to a program that executes its stdin, the body is the program, and a
  // quoted delimiter only stops expansion. Each was allowed before this fix.
  "bash <<'EOF'\nenv\nEOF",
  "bash <<EOF\nenv\nEOF",
  "sh -s <<'EOF'\nenv\nEOF",
  "bash -s <<EOF\nprintenv\nEOF",
  "sudo bash <<'EOF'\nenv\nEOF",
  "make -f - <<'EOF'\nall:\n\tenv\nEOF",
  "ssh host <<'EOF'\nenv\nEOF",
  "cat <<'EOF' | bash\nenv\nEOF",
  "cat <<'EOF' | sudo sh -s\nprintenv\nEOF",
  // ...and (Ally I1) executors that were never on the wrapper list, so the
  // first-ordinary-word stop turned every one into a pass-through.
  "ssh host env",
  "ssh -t host printenv",
  "docker run --rm alpine env",
  "docker exec c env",
  "kubectl exec pod -- printenv",
  "nsenter -t 1 -m env",
  "unshare -r env",
  "setpriv --reuid 0 env",
  "pkexec env",
  "taskset -c 0 env",
  "chrt -f 1 env",
  "systemd-run --scope env",
  "awk 'BEGIN{system(\"env\")}'",
  "perl -e 'system(\"env\")'",
  "capsh -- -c 'env'",
  // Ally I1 at a36d40f5: the language interpreters and the at/crontab
  // schedulers. Every row was blocked at the merge base and allowed at
  // a36d40f5. A heredoc fed to an interpreter is its program, and an
  // at/crontab body is shell that runs later.
  "python3 <<'EOF'\nimport os\nos.system(\"env\")\nEOF",
  "python <<'EOF'\nimport os\nos.system(\"env\")\nEOF",
  "ruby <<'EOF'\nsystem(\"env\")\nEOF",
  "php <<'EOF'\n<?php system(\"env\");\nEOF",
  "node <<'EOF'\nrequire(\"child_process\").execSync(\"env\")\nEOF",
  "cat <<'EOF' | node\nrequire(\"child_process\").execSync(\"env\")\nEOF",
  "cat <<'EOF' | python3\nimport os\nos.system(\"env\")\nEOF",
  "sudo python3 <<'EOF'\nimport os\nos.system(\"env\")\nEOF",
  "at now + 1 minute <<'EOF'\nenv\nEOF",
  // A crontab line's five schedule fields precede its command; read as an
  // ordinary first word they stopped the scan before `env`.
  "crontab - <<'EOF'\n* * * * * env\nEOF",
  "cat <<'EOF' | crontab -\n* * * * * env\nEOF",
  "crontab <<'EOF'\n@reboot printenv\nEOF",
  "sudo -u app crontab - <<'EOF'\n*/5 * * * * printenv\nEOF",
  // ...and their inline-program flags, whose payload word is the program.
  "python3 -c 'import os; os.system(\"env\")'",
  "python -c 'import os; os.system(\"env\")'",
  "python3 -Ic 'import os; os.system(\"env\")'",
  "node -e 'require(\"child_process\").execSync(\"env\")'",
  "node --eval 'require(\"child_process\").execSync(\"env\")'",
  "ruby -e 'system(\"env\")'",
  "php -r 'system(\"env\");'",
  // `|&` is a pipe (stderr too), so the body still reaches the next stage.
  "cat <<'EOF' |& bash\nenv\nEOF",
  "cat <<'EOF' |& python3\nimport os\nos.system(\"env\")\nEOF",
  // A word-initial `#` is a comment. Lexed as a word, an apostrophe in it
  // opened a quote that hid the rest of the body, `# <<EOF` opened a heredoc
  // that swallowed the next line, and in `env # note` it read as an operand.
  "bash <<'EOF'\n# it's fine\nenv\nEOF",
  "python3 <<'EOF'\n# it's fine\nimport os\nos.system(\"env\")\nEOF",
  "echo hi # <<EOF\nenv\nEOF",
  "env # note",
  // Ally I1 at 67d7b0a1: the tables match a RESOLVED basename. A versioned or
  // distro-aliased interpreter (`python3.11` on RHEL/CI images, `nodejs` on
  // Debian) missed all three tables by exact-string lookup and was allowed.
  "python3.11 -c 'import os; os.system(\"env\")'",
  "python3.12 -c 'import os; os.system(\"env\")'",
  "python3.9 -c 'import os; os.system(\"env\")'",
  "python2 -c 'import os; os.system(\"env\")'",
  "python2.7 -c 'import os; os.system(\"env\")'",
  "/usr/bin/python3.11 -c 'import os; os.system(\"env\")'",
  "nodejs -e 'require(\"child_process\").execSync(\"env\")'",
  "ruby3.1 -e 'system(\"env\")'",
  "ruby2.7 -e 'system(\"env\")'",
  "php8.2 -r 'system(\"env\");'",
  "php7.4 -r 'system(\"env\");'",
  "perl5.36 -e 'system(\"env\")'",
  "python3.11 <<'EOF'\nimport os\nos.system(\"env\")\nEOF",
  "python2.7 <<'EOF'\nimport os\nos.system(\"env\")\nEOF",
  "nodejs <<'EOF'\nrequire(\"child_process\").execSync(\"env\")\nEOF",
  "ruby3.1 <<'EOF'\nsystem(\"env\")\nEOF",
  "php8.2 <<'EOF'\n<?php system(\"env\");\nEOF",
  // Ally I2 at 67d7b0a1: perl and awk read a program from stdin too, and
  // `batch` is `at`'s sibling whose body is shell that runs later.
  "perl <<'EOF'\nsystem(\"env\")\nEOF",
  "cat <<'EOF' | perl\nsystem(\"env\")\nEOF",
  "sudo perl <<'EOF'\nsystem(\"env\")\nEOF",
  "awk -f - <<'EOF'\nBEGIN{system(\"env\")}\nEOF",
  "gawk -f - <<'EOF'\nBEGIN{system(\"env\")}\nEOF",
  "mawk -f - <<'EOF'\nBEGIN{system(\"env\")}\nEOF",
  "batch <<'EOF'\nenv\nEOF",
  // Ally I3 at 67d7b0a1: a flag that takes its value as the NEXT word. The
  // value is a bare word but not a script, so it must not end the flag scan.
  "python3 -W ignore -c 'import os; os.system(\"env\")'",
  "python3 -X dev -c 'import os; os.system(\"env\")'",
  "node -r dotenv/config -e 'require(\"child_process\").execSync(\"env\")'",
  "node --require dotenv/config -e 'require(\"child_process\").execSync(\"env\")'",
  "ruby -I lib -e 'system(\"env\")'",
  "ruby -r json -e 'system(\"env\")'",
  "php -d memory_limit=1G -r 'system(\"env\");'",
];
const allowed = [
  // The trailing terminator deliberately does NOT include whitespace, which is
  // what keeps an operand-bearing invocation out of the dump class. These are
  // the regression guard for the wrapper fix above: it must not start matching
  // a dump utility that is followed by an operand.
  "grep env file.txt",
  "grep -r env src/",
  "cat .env",
  "kubectl set image deploy/x c=y",
  "git commit -m 'add env parsing'",
  // Legitimate env USE (set-and-run) must not be blocked.
  "env FOO=bar node script.js",
  "printenv PATH",
  // An operand — a command to run, or a single variable to print — is what
  // makes these not-a-dump. Tightening the flag handling above must not
  // swallow them, including through a substitution or after `--`.
  "env NAME=value command",
  "env FOO=1 BAR=2 ./run.sh",
  "printenv HOME",
  "PATH=$(printenv PATH)",
  "env -- ls",
  "docker run --env-file .env img",
  // set with flags is ubiquitous in agent shells.
  "set -euo pipefail",
  "set -e",
  // Ordinary commands.
  "ls -la",
  "git status",
  'echo "hello"',
  "grep -r env .",
  // The allowlisted names-only helper.
  "node ~/.claude/safe-env-inspect.mjs",
  "./scripts/safe-env-inspect.mjs",
  "paperclip-safe-env",
  // Anchoring the helper exception must not over-block: args are fine, and a
  // compound command that merely *contains* the helper is still allowed when
  // nothing in it is an environment dump.
  "paperclip-safe-env --json",
  "scripts/safe-env-inspect.mjs",
  "cd /repo && paperclip-safe-env",
  // Newline-as-separator must not over-block ordinary multi-line scripts:
  // each line is classified as its own command, and none of these is a dump.
  "cd /repo\nset -euo pipefail\nls -la",
  "echo one\necho two",
  "cd /repo\npaperclip-safe-env",
  "export FOO=bar\nnode script.js",
  "printenv PATH\nprintenv HOME",
  // Round 6 — the normalizer must not over-block. Quote removal makes the
  // classifier see real words, so a dump utility NAME appearing as ordinary
  // prose or as an operand-bearing argument stays allowed. Nested re-analysis
  // is keyed on command SEPARATORS, not whitespace, precisely so these pass.
  'echo "hello env"',
  "git commit -m 'fix env'",
  'git commit -m "update env parsing docs"',
  "env -S 'node script.js'", // -S payload IS an operand here: it runs a command
  "env --split-string='node script.js'",
  "printenv PATH >/tmp/path.txt", // an operand, so not a dump; redirection is irrelevant
  'sh -c "ls -la"', // shell payload recursed, and it is not a dump
  "sh -c 'cd /repo && npm test'",
  "echo 'a > b'",
  // Round 7 — recording redirection targets must not turn an ordinary
  // redirect into a dump, and must not promote the target to an operand
  // (which would make `env >/tmp/out` above stop blocking).
  "cat </tmp/notes.txt",
  "sort < /etc/hostname",
  "node script.js </dev/null",
  "declare -f deploy", // function display, no -x in the cluster
  "declare -p PATH", // one named variable, not the exported set
  "export FOO=bar", // an assignment is a name operand, so it is scoped
  "export PATH",
  // BLO-40805 — DATA IS NOT A COMMAND POSITION. Every entry below was BLOCKED
  // before this fix, none of them can emit an environment value, and the guard
  // blocking them is what taught agents to reach for an encoding workaround.
  //
  // A single-quoted heredoc body is inert: no expansion, no word executed. The
  // fifth reproduction was writing a vitest fixture for THIS GUARD.
  "cat > /tmp/ac2.test.ts <<'TS'\nconst cases = ['env', 'printenv', 'set', 'declare -x'];\nTS",
  "cat > /tmp/f.sh <<'SH'\n#!/usr/bin/env bash\nset -euo pipefail\nenv\nSH",
  'cat > /tmp/f.sh <<"SH"\nprintenv\nSH',
  "cat <<-'EOF' > /tmp/f\n\tenv\nEOF",
  // A dump-shaped string in ARGUMENT position is data whatever separators it
  // carries. The first of these is the sixth reproduction, measured live while
  // this ticket was being worked: the word `env` inside a grep pattern.
  "gh pr list --json title --jq '.[].title' | grep -iE 'guard|40805|env'",
  "grep -iE 'guard|env' notes.txt",
  "echo env",
  "echo 'env; printenv'",
  "jq -r '.[]|.env' package.json",
  "sed -i 's/env/ENV/' file.txt",
  "#!/usr/bin/env bash",
  // Negative controls for the consumer rule: a body that only reaches a data
  // consumer stays data, even behind sudo or next to a later shell command.
  "tee /tmp/f <<'EOF'\nenv\nEOF",
  "sudo tee /etc/f <<'EOF'\nenv\nEOF",
  "cat <<'EOF' | sudo tee /etc/f\nenv\nEOF",
  // `&&` ends the pipeline, so the shell after it does not read this body.
  "cat > /tmp/f <<'EOF' && bash -c true\nenv\nEOF",
  "cat <<'EOF' | grep env\nenv\nEOF",
  // git is deliberately not a wrapper: `env` after it is a pattern or a
  // missing subcommand, never a dump.
  "git grep env",
  "git log --grep env",
  // The interpreters are NOT command-position wrappers: only an inline
  // program's payload word is scanned, so their ordinary arguments stay data.
  // Each of these blocked at the merge base, and listing the interpreters as
  // wrappers would re-block the first.
  "python3 -m venv env",
  "python -m venv .env",
  "node env.js",
  "python3 train.py --env prod",
  "ruby -S rake db:migrate",
  "node /usr/bin/npm ci",
  "python3 -c 'import sys; print(sys.argv)' env", // argv after the program
  "python3 -c 'print(1)'",
  "crontab -l",
  "python3 <<'EOF'\nprint('hello')\nEOF",
  "crontab - <<'EOF'\nMAILTO=\"\"\n0 3 * * * /usr/local/bin/backup.sh\nEOF",
  // Negative controls for the versioned-name, stdin-program and value-flag
  // rules above: none of these runs a program the guard can see.
  "python3.11 -m venv env",
  "nodejs env.js",
  "perl -ne 'print' env.log",
  "awk '{print}' /var/log/x",
  "batch -l",
  "python3 x.py -c foo", // a script argument, not the inline-program flag
  "python3 -W ignore x.py -c env", // the value is skipped, the script still ends the scan
  "ls # env", // a comment is not an argument, let alone a command
  "",
];

describe("classifyAgentShellCommand", () => {

  for (const cmd of blocked) {
    it(`blocks: ${JSON.stringify(cmd)}`, () => {
      const d = classifyAgentShellCommand(cmd);
      expect(d.action).toBe("block");
      expect(d.reason).toBe("full_environment_dump");
    });
  }

  for (const cmd of allowed) {
    it(`allows: ${JSON.stringify(cmd)}`, () => {
      expect(classifyAgentShellCommand(cmd).action).toBe("allow");
    });
  }
});

/**
 * Execute the literal embedded guard artifact as a real Node process, feeding
 * it a PreToolUse event on stdin — this validates the exact file the pod runs,
 * not a TS re-implementation.
 */
function runGuardScript(event: unknown): { status: number | null; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-guard-"));
  try {
    const file = path.join(dir, "guard.mjs");
    writeFileSync(file, ENV_GUARD_SCRIPT);
    const res = spawnSync(process.execPath, [file], {
      input: JSON.stringify(event),
      encoding: "utf8",
    });
    return { status: res.status, stderr: res.stderr ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("embedded guard script (real node process)", () => {
  it("exits 2 and explains on a Bash env dump", () => {
    const { status, stderr } = runGuardScript({ tool_name: "Bash", tool_input: { command: "env" } });
    expect(status).toBe(2);
    expect(stderr).toContain("PEN-1305");
    expect(stderr).toContain("safe-env-inspect.mjs");
  });

  it("exits 0 for a benign Bash command", () => {
    expect(runGuardScript({ tool_name: "Bash", tool_input: { command: "ls -la" } }).status).toBe(0);
  });

  it("exits 0 for the allowlisted helper", () => {
    const evt = { tool_name: "Bash", tool_input: { command: "node ~/.claude/safe-env-inspect.mjs" } };
    expect(runGuardScript(evt).status).toBe(0);
  });

  // DRIFT CONTROL. The embedded pod script carries its own copy of the
  // classifier, and hand-maintaining a second, shorter list of cases here is
  // exactly how the two copies diverged before: a fix landed in one, the
  // curated list did not grow, and the bypass survived in the artifact a pod
  // actually runs. So drive the WHOLE corpus through the real spawned process
  // and require it to agree with the TypeScript classifier on every case.
  // Adding a case to `blocked`/`allowed` above now covers both copies at once.
  for (const cmd of blocked) {
    it(`embedded copy blocks: ${JSON.stringify(cmd)}`, () => {
      const { status, stderr } = runGuardScript({ tool_name: "Bash", tool_input: { command: cmd } });
      expect(status).toBe(2);
      expect(stderr).toContain("PEN-1305");
      expect(classifyAgentShellCommand(cmd).action).toBe("block");
    });
  }

  for (const cmd of allowed) {
    it(`embedded copy allows: ${JSON.stringify(cmd)}`, () => {
      expect(runGuardScript({ tool_name: "Bash", tool_input: { command: cmd } }).status).toBe(0);
      expect(classifyAgentShellCommand(cmd).action).toBe("allow");
    });
  }

  it("still exits 0 when the helper is invoked with arguments", () => {
    const evt = { tool_name: "Bash", tool_input: { command: "paperclip-safe-env --json" } };
    expect(runGuardScript(evt).status).toBe(0);
  });

  it("exits 0 for a non-Bash tool even if the payload looks like a dump", () => {
    expect(runGuardScript({ tool_name: "Read", tool_input: { command: "env" } }).status).toBe(0);
  });

  it("fails open (exit 0) on malformed input", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pc-guard-"));
    try {
      const file = path.join(dir, "guard.mjs");
      writeFileSync(file, ENV_GUARD_SCRIPT);
      const res = spawnSync(process.execPath, [file], { input: "not json", encoding: "utf8" });
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("safe-env-inspect helper prints names only", () => {
  it("emits variable names, never values", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pc-safe-"));
    try {
      const file = path.join(dir, "safe.mjs");
      writeFileSync(file, SAFE_ENV_INSPECT_SCRIPT);
      const res = spawnSync(process.execPath, [file], {
        encoding: "utf8",
        env: { ...process.env, PC_TEST_SECRET: "super-secret-value-xyz" },
      });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain("PC_TEST_SECRET");
      expect(res.stdout).not.toContain("super-secret-value-xyz");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEnvGuardSetupShell", () => {
  // Recover the three base64 blobs the shell fragment installs.
  function decodedBlobs(shell: string): string[] {
    return [...shell.matchAll(/printf %s '([A-Za-z0-9+/=]+)'/g)].map((m) =>
      Buffer.from(m[1]!, "base64").toString("utf8"),
    );
  }

  // PEN — the agent HOME is a ReadWriteMany CephFS volume shared by every agent
  // pod. `> shared-file` is O_TRUNC, so every pod truncated the SAME inode; one
  // truncate wedging in the MDS hung open() fleet-wide and the poisoned dentry
  // could not even be renamed over. Nothing may truncate a shared path again.
  it("never truncates a shared file in place", () => {
    const shell = buildEnvGuardSetupShell();
    const redirects = [...shell.matchAll(/> "([^"]+)"/g)].map((m) => m[1]!);
    expect(redirects.length).toBeGreaterThan(0);
    for (const target of redirects) {
      expect(target).toMatch(/\.\$\$\.tmp$/);
    }
    // Every install is create-if-absent and lands via rename(2), never a rewrite.
    const installs = [...shell.matchAll(/\[ -f "([^"]+)" \] \|\|/g)].map((m) => m[1]!);
    expect(installs).toHaveLength(2);
    for (const target of installs) {
      const tmp = `${target.replace(/\/([^/]+)$/, "/.$1")}.$$.tmp`;
      expect(shell).toContain(`mv -f "${tmp}" "${target}"`);
    }
  });

  it("content-addresses the guard filename so a change lands as a new inode", () => {
    const shell = buildEnvGuardSetupShell();
    expect(shell).toMatch(/paperclip-env-guard\.[0-9a-f]{12}\.mjs/);
    expect(shell).toMatch(/export PAPERCLIP_GUARD_FILE/);
  });

  it("round-trips the guard + helper scripts through base64", () => {
    const blobs = decodedBlobs(buildEnvGuardSetupShell());
    expect(blobs).toContain(ENV_GUARD_SCRIPT);
    expect(blobs).toContain(SAFE_ENV_INSPECT_SCRIPT);
  });

  it("turns off Claude commit/PR attribution, overriding a seeded value (BLO-47692)", () => {
    const mergeScript = decodedBlobs(buildEnvGuardSetupShell())[2]!;
    const dir = mkdtempSync(path.join(tmpdir(), "pc-settings-"));
    try {
      writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({ attribution: { commit: "Co-Authored-By: Claude", sessionUrl: false }, includeCoAuthoredBy: true }),
      );
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, PAPERCLIP_GUARD_FILE: path.join(dir, "g.mjs") };
      expect(spawnSync(process.execPath, ["-"], { input: mergeScript, encoding: "utf8", env }).status).toBe(0);
      const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      expect(settings.attribution).toEqual({ commit: "", pr: "", sessionUrl: false });
      expect(settings.includeCoAuthoredBy).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges the PreToolUse hook idempotently, preserving existing hooks", () => {
    const shell = buildEnvGuardSetupShell();
    // The merge blob is the 3rd base64 (guard, helper, merge).
    const mergeScript = decodedBlobs(shell)[2]!;
    const dir = mkdtempSync(path.join(tmpdir(), "pc-settings-"));
    try {
      const guardFile = path.join(dir, "paperclip-env-guard.deadbeef1234.mjs");
      // Seed an existing Stop hook (must be preserved) alongside a STALE guard
      // entry pointing at the old fixed-name guard. On the shared volume that
      // stale path is the wedged inode every pod hung on, so it must be pruned.
      writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: `node ${path.join(dir, "paperclip-env-guard.mjs")}`,
                  },
                ],
              },
            ],
          },
        }),
      );
      const env = {
        ...process.env,
        CLAUDE_CONFIG_DIR: dir,
        PAPERCLIP_GUARD_FILE: guardFile,
      };
      const run = () => spawnSync(process.execPath, ["-"], { input: mergeScript, encoding: "utf8", env });
      expect(run().status).toBe(0);
      expect(run().status).toBe(0); // run twice → must stay idempotent

      const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      const pre = settings.hooks.PreToolUse;
      expect(Array.isArray(pre)).toBe(true);
      const guardEntries = pre.filter(
        (g: { matcher?: string }) => g.matcher === GUARD_HOOK_MATCHER,
      );
      expect(guardEntries).toHaveLength(1);
      expect(guardEntries[0].hooks[0].command).toBe(`node '${guardFile}'`);
      // The stale fixed-name guard hook is gone, not merely deduplicated.
      const raw = readFileSync(path.join(dir, "settings.json"), "utf8");
      expect(raw).not.toContain(`${path.join(dir, "paperclip-env-guard.mjs")}`);
      // Existing Stop hook survived.
      expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-registers a same-hash guard hook whose matcher is stale (BLO-46113)", () => {
    const mergeScript = decodedBlobs(buildEnvGuardSetupShell())[2]!;
    const dir = mkdtempSync(path.join(tmpdir(), "pc-settings-"));
    try {
      const guardFile = path.join(dir, "paperclip-env-guard.cccccccccccc.mjs");
      const cmd = `node '${guardFile}'`;
      writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] } }),
      );
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, PAPERCLIP_GUARD_FILE: guardFile };
      expect(spawnSync(process.execPath, ["-"], { input: mergeScript, env }).status).toBe(0);
      const pre = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")).hooks.PreToolUse;
      expect(pre).toEqual([{ matcher: GUARD_HOOK_MATCHER, hooks: [{ type: "command", command: cmd }] }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Both halves of BLO-39898, in one test on purpose. Quoting `cmd` without
  // widening GUARD_RE silently breaks pruning (the class excludes ' and the
  // pattern is $-anchored), so a hash rotation APPENDS a second live guard hook
  // — quieter and worse than the unquoted bug. Assert (a) and (b) together so
  // either mutation alone turns this red. The temp dir carries a literal quote
  // as well as a space, so dropping the `'\''` escaping is a third mutation
  // this test catches.
  it("quotes the hook command AND still prunes across a hash rotation", () => {
    const mergeScript = decodedBlobs(buildEnvGuardSetupShell())[2]!;
    // mkdtemp appends to the prefix, so the resulting path contains BOTH a
    // space and a literal single quote. The quote is what makes the `'\''`
    // escaping load-bearing: mutate it to a bare `'` and the recorded command
    // becomes an unterminated quoted string, so /bin/sh below exits non-zero.
    const dir = mkdtempSync(path.join(tmpdir(), "pc 'settings "));
    expect(dir).toContain(" ");
    expect(dir).toContain("'");
    try {
      const guardA = path.join(dir, "paperclip-env-guard.aaaaaaaaaaaa.mjs");
      const guardB = path.join(dir, "paperclip-env-guard.bbbbbbbbbbbb.mjs");
      // A stub standing in for the real guard: argv.length is 2 only when the
      // shell got the path as a SINGLE argument.
      writeFileSync(guardB, "console.log(process.argv.length);\n");
      const merge = (guard: string) =>
        spawnSync(process.execPath, ["-"], {
          input: mergeScript,
          encoding: "utf8",
          env: { ...process.env, CLAUDE_CONFIG_DIR: dir, PAPERCLIP_GUARD_FILE: guard },
        });
      expect(merge(guardA).status).toBe(0);
      expect(merge(guardB).status).toBe(0); // hash rotation

      const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      const hooks = settings.hooks.PreToolUse.flatMap(
        (g: { hooks?: { command?: string }[] }) => g.hooks ?? [],
      ).filter((h: { command?: string }) => h.command?.includes("paperclip-env-guard"));
      // (b) exactly one guard hook survives the rotation — not two.
      expect(hooks).toHaveLength(1);

      // (a) that recorded command runs, as one argument, through a real shell.
      const ran = spawnSync("/bin/sh", ["-c", hooks[0].command], { encoding: "utf8" });
      // `node` is resolved off /bin/sh's PATH because that is literally what is
      // recorded in settings.json. A runner without node on PATH gives rc 127,
      // which is an environment problem, not a quoting bug — say so here rather
      // than letting it surface as a bare status mismatch.
      expect(ran.stderr).not.toContain("not found");
      expect(ran.status).toBe(0);
      expect(ran.stdout.trim()).toBe("2");

      expect(hooks[0].command).toBe(`node '${guardB.replace(/'/g, "'\\''")}'`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// BLO-29526. The block message used to build its remediation path from $HOME
// while the installer writes to ${CLAUDE_CONFIG_DIR:-$HOME/.claude}. The pod
// sets CLAUDE_CONFIG_DIR to a session dir OUTSIDE $HOME, so the suggested
// command was always MODULE_NOT_FOUND. That is worse than a broken path:
// agents pipe the suggestion into a filter (`... 2>/dev/null | grep -i FOO`),
// so node's error went to the discarded stderr, grep read empty stdin, and the
// empty output read as "no variable matches FOO" — a confident wrong negative.
//
// So this installs for real with the two directories deliberately APART, then
// RUNS whatever the guard suggests. Asserting on the message string alone
// would not catch a move of the install target.
describe("block message resolves to the installed helper (BLO-29526)", () => {
  it("suggests a command that actually executes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "pc-install-"));
    try {
      const home = path.join(root, "home");
      // The space is deliberate. The suggestion is copy-pasted into a shell, so
      // an unquoted path would emit an un-runnable command; this is what makes
      // the quoting load-bearing rather than decorative.
      //
      // SCOPE: this covers the BLOCK MESSAGE only. It is NOT a claim that a
      // spaced config dir works end to end. SETTINGS_MERGE_SCRIPT still builds
      // `const cmd = "node " + guard` unquoted, so the hook REGISTRATION it
      // writes into settings.json would split on the space. Pre-existing, and
      // unreachable in production (session dirs are UUID-based).
      //
      // Do not "fix" that by quoting `cmd` alone: GUARD_RE is
      // /paperclip-env-guard[^\s"']*\.mjs$/ — it excludes `'` and anchors at
      // $, so a quoted command stops matching, the stale-guard pruning goes
      // silent, and every hash rotation leaks another live PreToolUse hook.
      // No test goes red for that. Both sites have to move together.
      const configDir = path.join(root, "session dir", ".claude");
      mkdirSync(home, { recursive: true });
      // Guard the guard: if these ever collapse to the same directory the test
      // stops exercising the drift condition and silently passes on a revert.
      expect(configDir).not.toBe(path.join(home, ".claude"));

      const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir };
      const setup = spawnSync("sh", ["-c", buildEnvGuardSetupShell()], { encoding: "utf8", env });
      expect(setup.status).toBe(0);

      const guardName = readdirSync(configDir).find((f) => f.startsWith("paperclip-env-guard."));
      expect(guardName).toBeTruthy();

      const blocked = spawnSync(process.execPath, [path.join(configDir, guardName!)], {
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "env" } }),
        encoding: "utf8",
        env,
      });
      expect(blocked.status).toBe(2);

      const suggested = /run: node '([^']+)'/.exec(blocked.stderr)?.[1];
      expect(suggested).toBeTruthy();
      expect(suggested).toContain(" ");

      const helper = spawnSync(process.execPath, [suggested!], {
        encoding: "utf8",
        env: { ...env, PC_TEST_SECRET: "super-secret-value-xyz" },
      });
      expect(helper.stderr).not.toContain("MODULE_NOT_FOUND");
      expect(helper.status).toBe(0);
      expect(helper.stdout).toContain("PC_TEST_SECRET");
      expect(helper.stdout).not.toContain("super-secret-value-xyz");

      // The guard must not block its own remediation. SAFE_ENV_INSPECTION_RE
      // does NOT match the quoted form (the path group excludes spaces and the
      // trailing quote), so what allows it is containsDump() — `node ...` is
      // not a dump. Pinned because the allowlist looks like the thing keeping
      // this working and is not, so a change there would read as safe.
      for (const cmd of [`node '${suggested}'`, `node '${suggested}' 2>/dev/null | grep -i PC_`]) {
        const again = spawnSync(process.execPath, [path.join(configDir, guardName!)], {
          input: JSON.stringify({ tool_name: "Bash", tool_input: { command: cmd } }),
          encoding: "utf8",
          env,
        });
        expect(again.status, `guard blocked its own suggestion: ${cmd}`).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * BLO-29965. Two runs of one agent each opened a PR for the same issue. The
 * guard must refuse a push / PR open when the server names a DIFFERENT run as
 * the issue's lock holder, and stay out of the way in every other case.
 * Async spawn, not spawnSync: the fake API lives in this process, and a
 * synchronous child would block the event loop that has to answer it.
 */
describe("embedded guard: lock re-assertion before outward side effects (BLO-29965)", () => {
  const ME = "run-mine";
  const LOCK_VARS = ["PAPERCLIP_TASK_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_API_URL", "PAPERCLIP_API_KEY"];

  /**
   * PEN-4315: the guard now asks two questions, so the fake API serves two
   * paths. `GET /api/issues/task-1` is the wake row; `GET /api/agents/me/inbox-lite`
   * is "does this run hold any execution lock". The inbox reply defaults to the
   * empty inbox, which is the pre-PEN-4315 world: entitlement unproven, so the
   * wake-row answer decides, exactly as it did before.
   */
  async function withApi(
    reply: { status: number; body?: unknown },
    fn: (vars: Record<string, string>, hits: () => number, inboxHits: () => number) => Promise<void>,
    inboxReply: { status: number; body?: unknown } = { status: 200, body: { rows: [] } },
  ) {
    let count = 0;
    let inboxCount = 0;
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer k");
      if (req.url === "/api/agents/me/inbox-lite") {
        inboxCount += 1;
        // The run id must travel with the probe: inbox-lite needs it to tell
        // the caller's own held rows from a foreign run's.
        expect(req.headers["x-paperclip-run-id"]).toBe(ME);
        res.writeHead(inboxReply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(inboxReply.body ?? {}));
        return;
      }
      count += 1;
      expect(req.url).toBe("/api/issues/task-1");
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await fn(
        {
          PAPERCLIP_TASK_ID: "task-1",
          PAPERCLIP_RUN_ID: ME,
          PAPERCLIP_API_URL: `http://127.0.0.1:${port}/`,
          PAPERCLIP_API_KEY: "k",
        },
        () => count,
        () => inboxCount,
      );
    } finally {
      server.close();
    }
  }

  async function run(command: string, vars: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), "pc-guard-"));
    const file = path.join(dir, "guard.mjs");
    writeFileSync(file, ENV_GUARD_SCRIPT);
    // Hermetic: never inherit a real run's lock vars (this suite may itself run in an agent pod).
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !LOCK_VARS.includes(k)),
    );
    try {
      return await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [file], { env: { ...base, ...vars } });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("close", (status) => resolve({ status, stderr }));
        child.stdin.end(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const foreign = { status: 200, body: { id: "task-1", identifier: "BLO-1", executionRunId: "run-other" } };

  for (const cmd of [
    "git push origin fix/x",
    "cd /w && git -C /w push -u origin HEAD",
    "git --no-pager push",
    "gh pr create --title t --body b",
    // BLO-46113: outward writes the text regex never matched.
    "gh pr merge 12 --squash",
    "gh api repos/O/R/pulls -X POST -f title=t",
    "gh api --method POST repos/O/R/pulls",
    "gh api repos/O/R/pulls -f head=x -f base=master",
    "gh api -X PATCH repos/O/R/git/refs/heads/x -f sha=abc",
    "gh api repos/O/R/merges -XPOST -f base=a -f head=b",
    "bash -c 'git push origin HEAD'",
    "ssh host 'cd /w && git push'",
    "bash <<'EOF'\ngit push origin HEAD\nEOF",
    // Ally on #2714: interpreter programs, a leading -R, and contents writes.
    `python3 -c "import os; os.system('git push')"`,
    `node -e "require('child_process').execSync('gh pr merge 3')"`,
    `perl -e 'system("git push origin HEAD")'`,
    "python3 <<'EOF'\nimport subprocess\nsubprocess.run(['sh', '-c', 'git push'])\nEOF",
    "gh -R O/R pr merge 1 --squash",
    "gh --repo=O/R pr create --fill",
    "gh api repos/O/R/contents/x -X PUT -f content=eA==",
  ]) {
    it(`blocks ${JSON.stringify(cmd)} when another run holds the lock`, async () => {
      await withApi(foreign, async (vars) => {
        const { status, stderr } = await run(cmd, vars);
        expect(status).toBe(2);
        expect(stderr).toContain("BLO-29965");
        expect(stderr).toContain("run-other");
        expect(stderr).toContain("holds no issue execution lock");
      });
    });
  }

  it("allows the push when THIS run holds the lock", async () => {
    await withApi({ status: 200, body: { executionRunId: ME } }, async (vars, hits, inboxHits) => {
      expect((await run("git push", vars)).status).toBe(0);
      expect(hits()).toBe(1);
      // The entitlement probe is on the blocking path only: the wake row
      // already answered, so the common case still costs one request.
      expect(inboxHits()).toBe(0);
    });
  });

  /**
   * PEN-4315 mode (1), the measured regression this change exists to remove.
   * Woken by a mention on row A, the run picks row B off its inbox, holds B's
   * execution lock, and pushes B's work. The old predicate read A, saw a
   * foreign holder and refused — five times in one day, once costing a
   * reviewed 826-line commit a whole run of publish latency.
   */
  it("allows the push when the WAKE row is foreign but this run holds another issue's lock", async () => {
    await withApi(
      foreign,
      async (vars, hits, inboxHits) => {
        expect((await run("git push", vars)).status).toBe(0);
        expect(hits()).toBe(1);
        expect(inboxHits()).toBe(1);
      },
      { status: 200, body: { rows: [{ id: "task-2", identifier: "BLO-2", activeRun: { id: ME } }] } },
    );
  });

  it("still blocks when the inbox shows only OTHER runs holding rows", async () => {
    await withApi(
      foreign,
      async (vars) => {
        expect((await run("git push", vars)).status).toBe(2);
      },
      { status: 200, body: { rows: [{ id: "task-2", identifier: "BLO-2", activeRun: { id: "run-other" } }, { id: "task-3", activeRun: null }] } },
    );
  });

  it("accepts a bare-array inbox body as well as { rows }", async () => {
    await withApi(
      foreign,
      async (vars) => {
        expect((await run("git push", vars)).status).toBe(0);
      },
      { status: 200, body: [{ id: "task-2", activeRun: { id: ME } }] },
    );
  });

  /**
   * The probe cannot invent an entitlement. When it errors the guard must fall
   * back to the pre-PEN-4315 answer — block — rather than treating an
   * unreachable inbox as proof the run holds a lock.
   */
  it("still blocks when the entitlement probe errors", async () => {
    await withApi(foreign, async (vars) => {
      expect((await run("git push", vars)).status).toBe(2);
    }, { status: 500 });
  });

  /**
   * PEN-4315: the old message asserted the command pushes “for” the wake row —
   * which the guard cannot know — and prescribed re-asserting that row's lock,
   * i.e. taking an unrelated row's lock to satisfy a check about a different
   * issue. Three of five reports were first misfiled as a wedged lock because
   * of that sentence.
   */
  it("block message neither claims the push is for the wake row nor prescribes taking its lock", async () => {
    await withApi(foreign, async (vars) => {
      const { stderr } = await run("git push", vars);
      expect(stderr).not.toContain("/api/issues/task-1/checkout");
      expect(stderr).not.toMatch(/moves a PR or ref, for BLO-1/);
      expect(stderr).not.toMatch(/Re-assert the lock first/);
      expect(stderr).toContain("not something this guard can see");
      expect(stderr).toContain("Do NOT check out BLO-1");
    });
  });

  it("allows the push when nobody holds the lock", async () => {
    await withApi({ status: 200, body: { executionRunId: null } }, async (vars) => {
      expect((await run("git push", vars)).status).toBe(0);
    });
  });

  it("fails open when the API errors", async () => {
    await withApi({ status: 500 }, async (vars) => {
      expect((await run("git push", vars)).status).toBe(0);
    });
  });

  it("never calls the API for commands that are not outward side effects", async () => {
    await withApi(foreign, async (vars, hits) => {
      for (const cmd of [
        "git status",
        "git commit -m push",
        "gh pr view 1",
        "echo pushing",
        // BLO-46113: a push that is only quoted data, and gh api reads.
        'echo "run git push later"',
        "git commit -m 'fix: git push now re-asserts the lock'",
        "gh api repos/O/R/pulls/12",
        "gh api repos/O/R/pulls -X GET",
        "gh api repos/O/R/contents/README.md",
        'python3 -c "print(1)"',
      ]) {
        expect((await run(cmd, vars)).status).toBe(0);
      }
      expect(hits()).toBe(0);
    });
  });

  async function runTool(tool_name: string, vars: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), "pc-guard-"));
    const file = path.join(dir, "guard.mjs");
    writeFileSync(file, ENV_GUARD_SCRIPT);
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !LOCK_VARS.includes(k)));
    try {
      return await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [file], { env: { ...base, ...vars } });
        child.on("close", resolve);
        child.stdin.end(JSON.stringify({ tool_name, tool_input: { owner: "O", repo: "R" } }));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("blocks GitHub MCP write tools on a foreign holder, and the hook matcher routes them (BLO-46113)", async () => {
    await withApi(foreign, async (vars, hits) => {
      for (const tool of ["mcp__github__create_pull_request", "mcp__github__push_files", "mcp__github__merge_pull_request"]) {
        expect(new RegExp(`^(?:${GUARD_HOOK_MATCHER})$`).test(tool)).toBe(true);
        expect(await runTool(tool, vars)).toBe(2);
      }
      expect(hits()).toBe(3);
      expect(await runTool("mcp__github__get_me", vars)).toBe(0);
      expect(hits()).toBe(3);
    });
  });

  /**
   * PEN-4315 mode (2), pinned as a DELIBERATE hole rather than left to be
   * rediscovered: a run with no task id — every timer wake, and every PR-review
   * run — pushes ungated and pays no request at all. It stays open because the
   * same population contains review runs that legitimately write `pulls`, which
   * this hook also gates; failing closed here would wedge every review. A clean
   * push under this branch is therefore not evidence of entitlement.
   */
  it("is out of scope (allows, no API call) when the run has no task id", async () => {
    await withApi(foreign, async (vars, hits, inboxHits) => {
      const { PAPERCLIP_TASK_ID: _omit, ...rest } = vars;
      expect((await run("git push", rest)).status).toBe(0);
      expect(hits()).toBe(0);
      expect(inboxHits()).toBe(0);
    });
  });
});
