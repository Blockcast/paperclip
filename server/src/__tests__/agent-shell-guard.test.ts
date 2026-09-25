import { describe, expect, it } from "vitest";
import { classifyAgentShellCommand } from "../agent-shell-guard.js";

describe("classifyAgentShellCommand", () => {
  it.each([
    "env",
    "printenv",
    "env -0",
    "printenv --null",
    "env --null",
    "printenv -0",
    "env -u DOES_NOT_EXIST",
    "env --unset DOES_NOT_EXIST",
    "env --unset=DOES_NOT_EXIST",
    "env -C /tmp",
    "env --chdir=/tmp",
    "env -S 'printf %s'",
    "env --split-string='printf %s'",
    "env -i",
    "env --ignore-environment",
    "env --",
    "env FOO=bar",
    "env FOO=bar BAR=baz",
    "command env --unset=DOES_NOT_EXIST",
    "/usr/bin/env -u DOES_NOT_EXIST",
    "env -u DOES_NOT_EXIST printenv",
    "env --unset DOES_NOT_EXIST printenv",
    "env --unset=DOES_NOT_EXIST printenv",
    "env -u DOES_NOT_EXIST env",
    "/usr/bin/env -u DOES_NOT_EXIST printenv --null",
    "env -u DOES_NOT_EXIST /usr/bin/printenv",
    "env --unset=DOES_NOT_EXIST /usr/bin/printenv --null",
    "/usr/bin/env -u DOES_NOT_EXIST /usr/bin/printenv",
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

  it.each([
    'for key in $(node scripts/safe-env-inspect.mjs); do printf "%s=%s\\n" "$key" "${!key}"; done',
    'bash -lc \'for key in $(scripts/safe-env-inspect.mjs); do printf "%s=%s\\n" "$key" "${!key}"; done\'',
  ])("blocks Bash indirect expansion composed with safe env inspection: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
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
    expect(classifyAgentShellCommand("env FOO=bar printf '%s\\n' \"$FOO\"").action).toBe("allow");
    expect(classifyAgentShellCommand("env -u DOES_NOT_EXIST true").action).toBe("allow");
    expect(classifyAgentShellCommand("env -u DOES_NOT_EXIST printenv PATH").action).toBe("allow");
    expect(classifyAgentShellCommand("env -u DOES_NOT_EXIST /usr/bin/printenv PATH").action).toBe("allow");
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

  // BLO-20989 Ally review (PR #971): the substring-anywhere match on
  // safe-env-inspect let a composed command through wholesale, so pairing it
  // with a per-key printenv loop reconstructed the full environment without
  // ever being inspected. Also covers the "Important" bypasses: node -p,
  // absolute/versioned interpreter paths, python's `- <<'PY'` stdin form,
  // and property access via `process["env"]` / `os.environ.copy()`.
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

  // Ally review round 2 (PR #971 follow-up): the whole-command allowlist's
  // trailing-args wildcard accepted shell metacharacters as "just another
  // argument," so command substitution ran before the helper ever started.
  it.each([
    `scripts/safe-env-inspect.mjs $(printenv >&2)`,
    `scripts/safe-env-inspect.mjs \`printenv\``,
    `echo $(safe-env-inspect; printenv)`,
    `node scripts/safe-env-inspect.mjs | xargs -n1 printenv`,
    `node scripts/safe-env-inspect.mjs | xargs printenv`,
  ])("blocks command substitution / xargs composed with the safe helper: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  // Ally review round 2: interpreter flag parsing missed combined/preceding
  // flags and piped stdin; bulk-access detection missed destructuring,
  // require(), Python's `from os import environ`, and dynamically indexed
  // (non-literal) bracket/.get() reads.
  it.each([
    `node --no-warnings -e 'console.log(process.env)'`,
    `node --input-type=commonjs -e 'console.log(process.env)'`,
    `node --input-type commonjs -e 'console.log(process.env)'`,
    `node -pe 'process.env'`,
    `node -ep 'process.env'`,
    `command node -e 'console.log(process.env)'`,
    `command -- node -e 'console.log(process.env)'`,
    `/usr/bin/env node -e 'console.log(process.env)'`,
    `/usr/bin/env node --input-type=commonjs -e 'console.log(process.env)'`,
    `env -i node -e 'console.log(process.env)'`,
    `env -u UNUSED node -e 'console.log(process.env)'`,
    `env --unset UNUSED node -e 'console.log(process.env)'`,
    `/usr/bin/env -S node -e 'console.log(process.env)'`,
    `FOO=bar command node -e 'console.log(process.env)'`,
    `python3 -I -c 'import os; print(os.environ)'`,
    `python3 -c'import os; print(os.environ)'`,
    `python3 -Ic'import os; print(os.environ)'`,
    `python3 -X=dev -c 'import os; print(os.environ)'`,
    `python3 -X dev -c 'import os; print(os.environ)'`,
    `command python3 -I -c 'import os; print(os.environ)'`,
    `command python3 -Ic'import os; print(os.environ)'`,
    `env python3 -c 'import os; print(os.environ)'`,
    `env python3 -Ic'import os; print(os.environ)'`,
    `printf 'console.log(process.env)\\n' | node`,
    `printf 'console.log(process.env)\\n' | /usr/bin/env node`,
    `node -e 'const {env}=process; console.log(env)'`,
    `node -p 'require("node:process").env'`,
    `python3 -c 'from os import environ; print(environ)'`,
    `python3 -c 'from os import environ; print(dict(environ))'`,
    `node -e 'console.log(process.env[process.argv[1]])'`,
    `node -e 'console.log(process.env["" + process.argv[1]])'`,
    `node -e 'console.log(process?.env["" + process.argv[1]])'`,
    `python3 -c 'import os,sys; print(os.environ[sys.argv[1]])'`,
    `python3 -c 'import os; key="TABASE_URL"; print(os.environ["DA" + key])'`,
    `python3 -c 'import os,sys; print(os.environ.get(sys.argv[1]))'`,
    `python3 -c 'import os; key="TABASE_URL"; print(os.environ.get("DA" + key))'`,
    `node -e 'const {env: e}=process; console.log(e)'`,
    `node -e 'const {env: e}=process; console.log(e["" + process.argv[1]])'`,
    `python3 -c 'import os as x; print(x.environ)'`,
    `python3 -c 'import os as x; key="TABASE_URL"; print(x.environ.get("DA" + key))'`,
    `printf 'console.log(process.env)\\n' | node --input-type=commonjs`,
    `printf 'const {env: e}=process; console.log(e)\\n' | node --input-type=commonjs`,
    `printf 'import os as x; print(x.environ)\\n' | python3 -I`,
    `node -e 'console.log(process?.env)'`,
    `node -e 'console.log(globalThis.process.env)'`,
    `node -e 'console.log(global.process.env)'`,
    `node -e 'console.log(globalThis?.process?.env)'`,
    `node -e 'console.log(process["e" + "nv"])'`,
    `node -e 'console.log(globalThis["process"].env)'`,
    `node -e 'console.log(globalThis?.["pro" + "cess"]?.env)'`,
    `node -e 'console.log(global["process"].env)'`,
    `node -e 'console.log((process).env)'`,
    `node -e 'console.log(((process)).env)'`,
    `node -e 'console.log((globalThis.process).env)'`,
    `node -e 'console.log(Reflect.get(process, "env"))'`,
    `node -e 'console.log(Reflect.get((process), "env"))'`,
    `node -e 'console.log(Reflect["get"](process, "env"))'`,
    `node -e 'const p=process; console.log(p.env)'`,
    `node -e 'let p; p=globalThis.process; console.log((p).env)'`,
    `node -e 'const p=process, q=p; console.log(q["env"])'`,
    `node -e 'const p=process; console.log(p["e" + "nv"])'`,
    `node -e 'const p=process; console.log(p?.["e" + "nv"])'`,
    `node -e 'const p=process; console.log(p[key])'`,
    `node -e 'const p=process; console.log((p)[key])'`,
    `node -e 'const p=process; console.log(p?.[key])'`,
    `node -e 'const p=global.process; console.log(p.env)'`,
    `node -e 'const p=process; console.log(Reflect.get(p, "env"))'`,
    `python3 -c 'import os; e=os.environ; print(e)'`,
    `python3 -c 'import os; o=os; print(o.environ)'`,
    `python3 -c 'import os; o=os; x=o; print(x.environ)'`,
  ])("blocks the round-2 interpreter/bulk-access bypasses: %s", (command) => {
    expect(classifyAgentShellCommand(command)).toEqual({
      action: "block",
      reason: "full_environment_dump",
    });
  });

  it.each([
    `python3 -c 'from os import environ; print(environ.get("DATABASE_URL"))'`,
    `python3 -c 'from os import environ; print(environ["DATABASE_URL"])'`,
    `node -e 'const {env: e}=process; console.log(e.DATABASE_URL)'`,
    `python3 -c 'import os as x; print(x.environ["DATABASE_URL"])'`,
    `python3 -c 'import os as x; print(x.environ.get("DATABASE_URL"))'`,
    `command node -e 'console.log(process.env.DATABASE_URL)'`,
    `node --input-type=commonjs -e 'console.log(process.env.DATABASE_URL)'`,
    `/usr/bin/env node -e 'console.log(process.env["DATABASE_URL"])'`,
    `env -i python3 -c 'import os; print(os.environ.get("DATABASE_URL"))'`,
    `node -e 'console.log(process.env["DATABASE+URL"])'`,
    `node -e 'console.log(process?.env.DATABASE_URL)'`,
    `node -e 'console.log(globalThis.process.env["DATABASE_URL"])'`,
    `node -e 'console.log((process).env.DATABASE_URL)'`,
    `node -e 'console.log((globalThis.process).env["DATABASE_URL"])'`,
    `node -e 'console.log(process["argv"])'`,
    `node -e 'console.log(globalThis["console"])'`,
    `node -e 'console.log(global.process.env.DATABASE_URL)'`,
    `node -e 'const p=process; console.log(p.env.DATABASE_URL)'`,
    `node -e 'const p=process, q=p; console.log(q.env["DATABASE_URL"])'`,
    `node -e 'const p=process; console.log(p.pid)'`,
    `node -e 'const p=process; console.log(p["argv"])'`,
    `node -e 'const p=process; console.log((p)["argv"])'`,
    `node -e 'const p=process; console.log(p?.["argv"])'`,
    `node -e 'const p=global.process; console.log(p.env.DATABASE_URL)'`,
    `python3 -c 'import os; print(os.environ["DATABASE+URL"])'`,
    `python3 -c 'import os; print(os.environ.get("DATABASE_URL", "fallback"))'`,
    `python3 -c 'import os; o=os; print(o.environ["DATABASE_URL"])'`,
    `python3 -c 'import os; o=os; x=o; print(x.environ.get("DATABASE_URL"))'`,
  ])("still allows scoped reads through the os-import alias: %s", (command) => {
    expect(classifyAgentShellCommand(command).action).toBe("allow");
  });
});
