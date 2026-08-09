export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

const SAFE_ENV_INSPECTION_RE = /(?:^|[\s;&|()])(?:\.\/scripts\/safe-env-inspect\.mjs|scripts\/safe-env-inspect\.mjs|safe-env-inspect|paperclip-safe-env)(?=[\s;&|()]|$)/;
const BASH_INDIRECT_EXPANSION_RE = /\$\{![^}\r\n]+\}/;
const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c(?:\s+|$)/;
const FULL_ENV_DUMP_RE = new RegExp([
  String.raw`(?:^|[;&|]\s*)(?:command\s+)?(?:\/usr\/bin\/)?(?:env|printenv)(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)(?:set)(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)export\s+-p(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)declare\s+-x(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)cat\s+\/proc\/(?:self|\d+)\/environ(?:\s*(?:[;&|]|$))`,
  String.raw`\/proc\/(?:self|\d+)\/environ`,
].join("|"), "i");

function readShellCommandArgument(input: string): string {
  const rest = input.trimStart();
  if (!rest) return "";
  const quote = rest[0];
  if (quote === "'" || quote === '"') {
    let out = "";
    for (let i = 1; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === quote) return out;
      if (quote === '"' && ch === "\\" && i + 1 < rest.length) {
        i += 1;
        out += rest[i] ?? "";
      } else {
        out += ch;
      }
    }
    return out;
  }
  return /^[^\s]+/.exec(rest)?.[0] ?? "";
}

function unwrapShell(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_COMMAND_PREFIX_RE.exec(current);
    if (!match) return current;
    current = readShellCommandArgument(current.slice(match[0].length));
  }
  return current;
}

export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  const usesSafeEnvInspection = SAFE_ENV_INSPECTION_RE.test(normalized);
  if (usesSafeEnvInspection && BASH_INDIRECT_EXPANSION_RE.test(normalized)) {
    return { action: "block", reason: "full_environment_dump" };
  }
  if (usesSafeEnvInspection) return { action: "allow", reason: "safe_env_inspection" };
  return { action: "allow", reason: "not_environment_dump" };
}
