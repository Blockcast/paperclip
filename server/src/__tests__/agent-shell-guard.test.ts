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
  });
});
