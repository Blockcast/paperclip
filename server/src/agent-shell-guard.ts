export type AgentShellCommandDecision =
  | { action: "allow"; reason: "safe_env_inspection" | "not_environment_dump" }
  | { action: "block"; reason: "full_environment_dump" };

const SAFE_ENV_INSPECTION_RE = /(?:^|[\s;&|()])(?:\.\/scripts\/safe-env-inspect\.mjs|scripts\/safe-env-inspect\.mjs|safe-env-inspect|paperclip-safe-env)(?:\s|$)/;
const SHELL_WRAPPER_RE = /^(?:\/bin\/)?(?:ba|z|)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/;
const FULL_ENV_DUMP_RE = new RegExp([
  String.raw`(?:^|[;&|]\s*)(?:command\s+)?(?:\/usr\/bin\/)?(?:env|printenv)(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)(?:set)(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)export\s+-p(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)declare\s+-x(?:\s*(?:[;&|]|$))`,
  String.raw`(?:^|[;&|]\s*)cat\s+\/proc\/(?:self|\d+)\/environ(?:\s*(?:[;&|]|$))`,
  String.raw`\/proc\/(?:self|\d+)\/environ`,
].join("|"), "i");

function unwrapShell(command: string): string {
  let current = command.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = SHELL_WRAPPER_RE.exec(current);
    if (!match) return current;
    current = match[2] ?? current;
  }
  return current;
}

export function classifyAgentShellCommand(command: string): AgentShellCommandDecision {
  const normalized = unwrapShell(command).trim();
  if (!normalized) return { action: "allow", reason: "not_environment_dump" };
  if (SAFE_ENV_INSPECTION_RE.test(normalized)) return { action: "allow", reason: "safe_env_inspection" };
  if (FULL_ENV_DUMP_RE.test(normalized)) return { action: "block", reason: "full_environment_dump" };
  return { action: "allow", reason: "not_environment_dump" };
}
