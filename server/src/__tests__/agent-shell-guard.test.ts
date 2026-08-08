import { describe, expect, it } from "vitest";
import { classifyAgentShellCommand } from "../agent-shell-guard.js";

describe("classifyAgentShellCommand", () => {
  it.each([
    "env",
    "printenv",
    "set",
    "export -p",
    "declare -x",
    "cat /proc/self/environ",
    "tr '\\0' '\\n' < /proc/self/environ",
    "bash -lc 'env'",
    "sh -lc \"printenv\"",
    "sh -lc env",
    "bash -c printenv",
    "/bin/sh -lc env",
    "sh -c env ignored",
    'bash -c "env" ignored',
    "bash -c 'printenv' ignored",
    'bash -lc "sh -c env ignored"',
    "paperclip-safe-env && printenv",
  ])("blocks full-environment dump command %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    "scripts/safe-env-inspect.mjs",
    "./scripts/safe-env-inspect.mjs --names-only",
    "paperclip-safe-env",
    "safe-env-inspect --json",
    'sh -c "./scripts/safe-env-inspect.mjs --names-only" ignored',
  ])("allows the safe env-inspection path %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "allow",
      reason: "safe_env_inspection",
    });
  });

  it("does not block scoped env reads", () => {
    expect(classifyAgentShellCommand("printenv PATH")).toEqual({
      action: "allow",
      reason: "not_environment_dump",
    });
    expect(classifyAgentShellCommand('bash -c "printenv PATH" ignored')).toEqual({
      action: "allow",
      reason: "not_environment_dump",
    });
  });

  it.each([
    `node -e 'console.log(process.env)'`,
    `node -e "console.log(process.env)"`,
    `node --eval 'console.log(process.env)'`,
    `node -e 'console.log(Object.keys(process.env))'`,
    `node -e 'console.log(Object.entries(process.env))'`,
    `node -e 'console.log(JSON.stringify(process.env))'`,
    `node -e 'console.log({...process.env})'`,
    `node -e 'for (const k in process.env) console.log(k)'`,
    `echo -e harmless; node -e 'console.log(process.env)'`,
    `python3 -c 'import os; print(os.environ)'`,
    `python3 -c 'import os; print(dict(os.environ))'`,
    `python3 -c 'import os; print(os.environ.items())'`,
    `python -c 'import os; print(list(os.environ))'`,
    `python3 -c 'import os; print({**os.environ})'`,
    `bash -lc "node -e 'console.log(process.env)'"`,
  ])("blocks the BLO-20989 node/python process-environment dump bypass: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    `node -e 'console.log(process.env.DATABASE_URL)'`,
    `node -e "console.log(process.env['DATABASE_URL'])"`,
    `python3 -c 'import os; print(os.environ["DATABASE_URL"])'`,
    `python3 -c 'import os; print(os.environ.get("DATABASE_URL"))'`,
    `grep -rn "process.env)" src/`,
  ])("does not block scoped process-environment reads or unrelated matches: %s", (command) => {
    expect(classifyAgentShellCommand(command).action).toBe("allow");
  });

  it.each([
    `for k in $(node scripts/safe-env-inspect.mjs); do printenv "$k"; done`,
    `for k in $(scripts/safe-env-inspect.mjs); do echo "$k=$(printenv "$k")"; done`,
    `k=DATABASE_URL; printenv "$k"`,
    `printenv $SOME_VAR`,
    `node -p 'process.env'`,
    `/usr/bin/node -e 'console.log(process.env)'`,
    `/usr/local/bin/python3.11 -c 'import os; print(os.environ)'`,
    `python3 - <<'PY'\nimport os\nprint(os.environ)\nPY`,
    `node -e 'console.log(process["env"])'`,
    `node -e "console.log(process['env'])"`,
    `python3 -c 'import os; print(os.environ.copy())'`,
  ])("blocks the review-flagged bypass/composition: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    "node scripts/safe-env-inspect.mjs && echo done",
    "printenv PATH; echo ok",
  ])("still allows the inspector composed with harmless follow-on commands: %s", (command) => {
    expect(classifyAgentShellCommand(command).action).toBe("allow");
  });

  it.each([
    `scripts/safe-env-inspect.mjs $(printenv >&2)`,
    "scripts/safe-env-inspect.mjs `printenv`",
    `echo $(safe-env-inspect; printenv)`,
    `node scripts/safe-env-inspect.mjs | xargs -n1 printenv`,
    `node scripts/safe-env-inspect.mjs | xargs printenv`,
  ])("blocks command substitution / xargs composed with the safe helper: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    `node --no-warnings -e 'console.log(process.env)'`,
    `node -pe 'process.env'`,
    `node -ep 'process.env'`,
    `python3 -I -c 'import os; print(os.environ)'`,
    `printf 'console.log(process.env)\\n' | node`,
    `node -e 'const {env}=process; console.log(env)'`,
    `node -p 'require("node:process").env'`,
    `python3 -c 'from os import environ; print(environ)'`,
    `python3 -c 'from os import environ; print(dict(environ))'`,
    `node -e 'console.log(process.env[process.argv[1]])'`,
    `python3 -c 'import os,sys; print(os.environ[sys.argv[1]])'`,
    `python3 -c 'import os,sys; print(os.environ.get(sys.argv[1]))'`,
  ])("blocks the round-2 interpreter/bulk-access bypasses: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    `node --require ./bootstrap -e 'console.log(process.env)'`,
    `python3 -W ignore -c 'import os; print(os.environ)'`,
    `node -e 'console.log(process.env || {})'`,
    `node -e 'const {env: runtimeEnv}=process; console.log(runtimeEnv[process.argv[1]])'`,
    `python3 -c 'from os import environ as runtime_env; import sys; print(runtime_env[sys.argv[1]])'`,
    `node -e 'console.log(process . env)'`,
    `python3 -c 'import os; print(os . environ)'`,
    `python3 -c 'import os as runtime_os; print(runtime_os.environ)'`,
  ])("blocks option, alias, and whitespace variants of inline bulk access: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    `node -e 'const p = process; console.log(p.env)'`,
    `node -e 'console.log(process?.env)'`,
    `node -e 'console.log(Reflect.get(process, "env"))'`,
    `node -e 'console.log(require("node:process")["env"])'`,
    `python3 -c 'from os import *; print(environ)'`,
    `python3 -c 'import os; print(getattr(os, "environ"))'`,
    `python3 -c 'print(__import__("os").environ)'`,
  ])("blocks alias, optional-chain, and reflective full-environment forms: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    `python3 -c 'from os import environ; print(environ.get("DATABASE_URL"))'`,
    `python3 -c 'from os import environ; print(environ["DATABASE_URL"])'`,
    `node -e 'const {env: runtimeEnv}=process; console.log(runtimeEnv.DATABASE_URL)'`,
    `python3 -c 'from os import environ as runtime_env; print(runtime_env["DATABASE_URL"])'`,
    `python3 -c 'import os as runtime_os; print(runtime_os.environ.get("DATABASE_URL"))'`,
  ])("still allows scoped reads through the os-import alias: %s", (command) => {
    expect(classifyAgentShellCommand(command).action).toBe("allow");
  });

  it.each([
    `node -e 'console.log(process.env?.DATABASE_URL)'`,
    "node -e 'console.log(process.env[`DATABASE_URL`])'",
    `node -e 'console.log(process.env["DATABASE_URL"])'`,
    `python3 -c 'import os; print(os.environ.get(key="DATABASE_URL"))'`,
    `node -e 'console.log("process.env")'`,
    `python3 -c 'print("os.environ")'`,
  ])("allows scoped reads and harmless environment-reference strings: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "allow",
      reason: "not_environment_dump",
    });
  });
});
