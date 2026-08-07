import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ENV_GUARD_SCRIPT,
  SAFE_ENV_INSPECT_SCRIPT,
  buildEnvGuardSetupShell,
  classifyAgentShellCommand,
} from "./env-guard.js";

describe("classifyAgentShellCommand", () => {
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
    "",
  ];

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

  // The embedded script carries its own copy of the regexes, so the
  // compound-command bypass must be pinned here too — not just on the
  // TypeScript classifier. These are the exact commands that returned `allow`
  // before the safe-helper exception was anchored to the whole command, plus
  // the newline-separated forms that survived that anchoring.
  for (const cmd of [
    "paperclip-safe-env && env",
    "safe-env-inspect; printenv",
    "./scripts/safe-env-inspect.mjs && cat /proc/self/environ",
    'sh -lc "paperclip-safe-env && env"',
    "paperclip-safe-env\nenv",
    "safe-env-inspect.mjs\nprintenv",
    "echo ok\nenv",
    "echo ok\nset",
    "echo ok\nexport -p",
    "echo ok\ndeclare -x",
    "echo ok\r\nenv",
    'sh -lc "echo ok\nenv"',
    // Flag-only dumps and command substitution, in the real spawned artifact.
    "env -0",
    "printenv --null",
    "env -u PATH",
    'echo "$(env)"',
    "echo `env`",
    "X=$(printenv)",
    "(env)",
    'sh -lc "echo $(env)"',
    // Unquoted command wrappers, in the real spawned artifact. The embedded
    // script carries its own regex literals, so the leading-boundary widening
    // has to be pinned here too and not only on the TypeScript classifier.
    "sh -c env",
    "bash -c env",
    "/bin/sh -c env",
    "zsh -c env",
    "sh -c printenv",
    "eval env",
    "xargs env",
    "nohup env",
    "timeout 5 env",
  ]) {
    it(`exits 2 on compound bypass: ${JSON.stringify(cmd)}`, () => {
      const { status, stderr } = runGuardScript({ tool_name: "Bash", tool_input: { command: cmd } });
      expect(status).toBe(2);
      expect(stderr).toContain("PEN-1305");
    });
  }

  // ...and the embedded copy must not over-block multi-line scripts either.
  for (const cmd of [
    "cd /repo\nset -euo pipefail\nls -la",
    "cd /repo\npaperclip-safe-env",
    "env FOO=bar node script.js",
    "printenv HOME",
    "PATH=$(printenv PATH)",
    "env -- ls",
  ]) {
    it(`exits 0 on benign multi-line: ${JSON.stringify(cmd)}`, () => {
      expect(runGuardScript({ tool_name: "Bash", tool_input: { command: cmd } }).status).toBe(0);
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

  it("round-trips the guard + helper scripts through base64", () => {
    const blobs = decodedBlobs(buildEnvGuardSetupShell());
    expect(blobs).toContain(ENV_GUARD_SCRIPT);
    expect(blobs).toContain(SAFE_ENV_INSPECT_SCRIPT);
  });

  it("merges the PreToolUse hook idempotently, preserving existing hooks", () => {
    const shell = buildEnvGuardSetupShell();
    // The merge blob is the 3rd base64 (guard, helper, merge).
    const mergeScript = decodedBlobs(shell)[2]!;
    const dir = mkdtempSync(path.join(tmpdir(), "pc-settings-"));
    try {
      // Seed an existing Stop hook to prove it is preserved.
      writeFileSync(
        path.join(dir, "settings.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } }),
      );
      const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
      const run = () => spawnSync(process.execPath, ["-"], { input: mergeScript, encoding: "utf8", env });
      expect(run().status).toBe(0);
      expect(run().status).toBe(0); // run twice → must stay idempotent

      const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8"));
      const pre = settings.hooks.PreToolUse;
      expect(Array.isArray(pre)).toBe(true);
      const guardEntries = pre.filter(
        (g: { matcher?: string }) => g.matcher === "Bash",
      );
      expect(guardEntries).toHaveLength(1);
      expect(guardEntries[0].hooks[0].command).toContain("paperclip-env-guard.mjs");
      // Existing Stop hook survived.
      expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
